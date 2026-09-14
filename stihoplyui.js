/* СТИХОПЛЮЙ v4.0 — клон логики GrinchSoft 1991
 * Алгоритм:
 *   - словарь: 42-байтные записи CP866 (word | stress | rhyme | POS)
 *   - конфиг: имена файлов + 14 строк × поле (25 знаков: шаблон ударений + буква рифмы)
 *   - генерация: для каждой строки подбираются слова из словаря, чей шаблон ударений
 *     совпадает с метром строки (целиком или по слотам); рифма — по последнему слову;
 *     применяются POS-ограничения по позиции в строке.
 */

'use strict';

// ------------------------------------------------------------------
// ПАРСЕР СЛОВАРЯ (.dat) — CP866 → UTF-8, записи переменной длины с CRLF
// ------------------------------------------------------------------

/**
 * Парсит одну запись словаря. Запись — массив байтов БЕЗ хвостового CRLF.
 * Формат (1-индексированные позиции):
 *   1..25 (bytes 0..24)  слово, по левому краю, пробелы справа
 *   26..35 (bytes 25..34) схема ударений, выравнена по левому краю,
 *                          остаток — пробелы (падинг)
 *   36..40 (bytes 35..39) ключ рифмы (5 знаков)
 *   41..42 (bytes 40..41) часть речи: N, A, AV, VН, VП, ?V, ?, пробел
 *
 * @param {Uint8Array} rec — байты одной записи (длина 40-42)
 * @returns {Object} {word, stress, rhyme, pos}
 */
function parseDictRecord(rec) {
  // Слово: байты 0..24, пробелы допустимы внутри (фразы типа "законный брак")
  const wordBytes = rec.subarray(0, Math.min(25, rec.length));
  const word = decodeCp866(wordBytes).trimEnd();

  // Шаблон ударений: байты 25..34 (всего 10 знаков, остаток — пробелы).
  // Читаем только значащую часть (до первого пробела): '-' = безударный, '\'' = ударный.
  let stress = '';
  for (let i = 25; i < 35 && i < rec.length; i++) {
    const b = rec[i];
    if (b === 0x20) break;                       // конец значащей части
    stress += (b === 0x27) ? "'" : '-';
  }

  // Ключ рифмы: байты 35..39 (5 знаков), пробелы выкидываются
  const rhymeBytes = rec.subarray(35, Math.min(40, rec.length));
  const rhyme = decodeCp866(rhymeBytes).replace(/\s+/g, '');

  // POS: байты 40..41 (0-2 знака), допустимы: ' ', 'N', 'A', 'V', '?'
  const posBytes = rec.subarray(40, Math.min(42, rec.length));
  let pos = '';
  for (let i = 0; i < posBytes.length; i++) {
    const b = posBytes[i];
    if (b !== 0x20) pos += String.fromCharCode(b);
  }

  return { word, stress, rhyme, pos };
}

/** Декодирует произвольный кусок байтов CP866 → строка UTF-8 */
function decodeCp866(bytes) {
  return CP866_DECODER.decode(bytes);
}

const CP866_DECODER = new TextDecoder('cp866');

/**
 * Парсит весь файл словаря.
 * Поддерживает CP866 (оригинал DOS) и UTF-8.
 *
 * Важно: парсер работает с СЫРЫМИ БАЙТАМИ раз за раз (позиции 0-24, 25-34 и т.д.
 * заданы в байтах исходного файла). Если файл в UTF-8, мы должны сначала
 * перекодировать его в CP866-байты, чтобы позиции совпали.
 *
 * @param {ArrayBuffer} buf
 * @returns {Array<Object>}
 */
function parseDictionary(buf) {
  const u8 = new Uint8Array(buf);

  // Эвристика кодировки
  let useUtf8 = false;
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) {
    useUtf8 = true;
  } else {
    let utf8Markers = 0;
    let cp866Markers = 0;
    const probe = Math.min(128, u8.length);
    for (let k = 0; k < probe; k++) {
      const b = u8[k];
      if (b === 0xd0 || b === 0xd1) utf8Markers++;
      if (b >= 0x80 && b <= 0xaf) cp866Markers++;
    }
    useUtf8 = utf8Markers > cp866Markers && utf8Markers > 0;
  }

  // Если UTF-8 — перекодируем в CP866-байты (как требует формат записей).
  // Если уже CP866 — используем сырые байты как есть.
  let bytesToUse;
  if (useUtf8) {
    const startByte = (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) ? 3 : 0;
    const text = new TextDecoder('utf-8').decode(u8.subarray(startByte));
    const lines = text.split(/\r?\n/);
    const buf2 = [];
    for (let li = 0; li < lines.length; li++) {
      if (li > 0) buf2.push(0x0d, 0x0a);              // CRLF между записями
      const lb = cp866FromUtf8(lines[li]);
      for (let j = 0; j < lb.length; j++) buf2.push(lb[j]);
    }
    bytesToUse = new Uint8Array(buf2);
  } else {
    bytesToUse = u8;
  }

  // Теперь идём по СЫРЫМ байтам — для CP866 это и есть исходные позиции.
  const result = [];
  let i = 0;
  while (i < bytesToUse.length) {
    let j = i;
    while (j < bytesToUse.length && bytesToUse[j] !== 0x0a) j++;
    let end = j;
    if (end > i && bytesToUse[end - 1] === 0x0d) end--;     // уберём CR
    const lineBytes = bytesToUse.subarray(i, end);
    i = j + 1;
    if (lineBytes.length < 35) continue;
    const rec = parseDictRecord(lineBytes);
    if (!rec.word) continue;
    result.push(rec);
  }
  return result;
}

/**
 * Перекодирует UTF-8 строку в CP866-байты (по символам Unicode).
 * Используется, когда пользователь загрузил `.dat`, пересохранённый в UTF-8,
 * а нам нужно восстановить исходные позиции байтов.
 */
const CP866_ENCODE_TABLE = (() => {
  // карта Unicode → CP866 для кириллицы
  const u = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя';
  const c = [0x80,0x81,0x82,0x83,0x84,0x85,0x86,0x87,0x88,0x89,0x8a,0x8b,0x8c,0x8d,0x8e,0x8f,
             0x90,0x91,0x92,0x93,0x94,0x95,0x96,0x97,0x98,0x99,0x9a,0x9b,0x9c,0x9d,0x9e,0x9f,
             0xa0,0xa1,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,0xa8,0xa9,0xaa,0xab,0xac,0xad,0xae,0xaf,
             0xe0,0xe1,0xe2,0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,0xea,0xeb,0xec,0xed,0xee,0xef,
             0xf0,0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,0xf9,0xfa,0xfb,0xfc,0xfd,0xfe,0xff];
  const m = new Map();
  for (let i = 0; i < u.length; i++) m.set(u.charCodeAt(i), c[i]);
  return m;
})();
function cp866FromUtf8(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const cc = str.charCodeAt(i);
    if (cc < 0x80) { out.push(cc); continue; }
    if (CP866_ENCODE_TABLE.has(cc)) out.push(CP866_ENCODE_TABLE.get(cc));
    else out.push(0x3f);   // '?'
  }
  return new Uint8Array(out);
}

// ------------------------------------------------------------------
// ПАРСЕР КОНФИГА (.cfg) — CP866 фиксированной ширины
// ------------------------------------------------------------------

/**
 * Парсит конфиг строфы.
 * Формат (восстановлен по ONEGIN.CFG):
 *   1..35   (bytes 0..34)  имя файла словаря
 *   36..70  (bytes 35..69) имя файла ресурсов
 *   далее для каждой строки строфы поле 25 знаков:
 *     в начале — шаблон ударений (знаки '-' и '\'', без пробелов внутри)
 *     последний знак поля (если не пробел) — буква рифмы
 *
 * Всего под строфу отведено 20 полей × 25 = 500 знаков. Файл = 70 + 500 = 570 байт.
 *
 * @param {ArrayBuffer} buf
 * @returns {{dictName,resName,lines:[{stress,rhyme}]}}
 */
function parseConfig(buf) {
  const u8 = new Uint8Array(buf);
  const text = CP866_DECODER.decode(u8);
  const dictName = text.substring(0, 35).trim() || 'rhymer.dat';
  const resName  = text.substring(35, 70).trim() || 'rhymer.res';

  const lines = [];
  for (let i = 0; i < 20; i++) {        // максимум 20 строк в формате
    const fieldStart = 70 + i * 25;
    if (fieldStart >= text.length) break;
    const field = text.substring(fieldStart, fieldStart + 25);
    if (!field || !field.trim()) break;
    // последний не-пробельный знак = буква рифмы
    const trimmed = field.replace(/\s+$/, '');
    if (!trimmed) continue;
    const rhyme = trimmed.charAt(trimmed.length - 1);
    const stress = trimmed.substring(0, trimmed.length - 1).trim();
    lines.push({ stress, rhyme });
  }
  return { dictName, resName, lines };
}

// ------------------------------------------------------------------
// АЛГОРИТМ ПОДБОРА (ядро)
// ------------------------------------------------------------------

/** Канонизация шаблона ударений: схлопываем пробелы, оставляем только - и ' */
function canonStress(s) {
  return s.replace(/\s+/g, '').replace(/[^-\']/g, '-');
}

/** Индекс словаря: паттерн ударений → массив записей (только ненулевые) */
function buildIndex(dict) {
  const idx = new Map();
  for (const rec of dict) {
    const c = canonStress(rec.stress);
    if (!c) continue;
    if (!idx.has(c)) idx.set(c, []);
    idx.get(c).push(rec);
  }
  return idx;
}

/**
 * Подбирает ВСЕ возможные разложения шаблона строки на последовательность слов
 * из словаря (бэктрекинг). Каждое слово занимает непрерывный префикс оставшегося
 * шаблона. Лимит рекурсии — 8 слов (как в оригинале).
 *
 * @param {string} pattern  шаблон ударений всей строки
 * @param {Map} indexByStress  индекс словаря
 * @param {Object} [opts]
 * @param {number} [opts.maxDepth=8]
 * @param {Set}    [opts.bannedWords] — множество слов, которых надо избегать
 * @returns {Array<Array<Object>>} массив вариантов разложения (каждый — массив слов)
 */
function findDecompositions(pattern, indexByStress, opts = {}) {
  const { maxDepth = 8, bannedWords = new Set(), cap = 200, perFirstCap = 4 } = opts;
  const results = [];

  // Шаг 1: собираем все слова, которые могут стоять в начале строки,
  // вместе с тем, какой шаблон они покрывают.
  // firstChoices: [{word, prefixLen}, ...]
  const firstChoices = [];
  const seenFW = new Set();
  for (let len = 1; len <= Math.min(pattern.length, 8); len++) {
    const cands = indexByStress.get(pattern.substring(0, len)) || [];
    for (const w of cands) {
      if (bannedWords.has(w.word)) continue;
      if (seenFW.has(w.word)) continue;
      seenFW.add(w.word);
      firstChoices.push({ word: w, prefixLen: len });
    }
  }
  shuffleInPlace(firstChoices);

  // Шаг 2: для каждого первого слова делаем ОТДЕЛЬНЫЙ бэктрекинг с cap=perFirstCap.
  // Так суммарная работа = O(unique_first_words * perFirstCap * subtree_size).
  for (const { word, prefixLen } of firstChoices) {
    if (results.length >= cap) break;
    const subDecs = backtrackFromFirst(pattern.substring(prefixLen), [word], indexByStress, {
      maxDepth, bannedWords, cap: perFirstCap,
    });
    for (const sd of subDecs) results.push(sd);
  }

  // Финальное перемешивание результатов (разные запуски ⇒ разный порядок)
  shuffleInPlace(results);
  return results;
}

/**
 * Бэктрекинг с уже выбранным первым словом. Возвращает до `cap` декомпозиций.
 */
function backtrackFromFirst(remaining, current, indexByStress, opts) {
  const { maxDepth, bannedWords, cap } = opts;
  const results = [];

  function bt(rem, cur, depth) {
    if (results.length >= cap) return;
    if (rem.length === 0) { results.push(cur.slice()); return; }
    if (depth >= maxDepth) return;

    const maxLen = Math.min(rem.length, 8);
    const lens = [];
    for (let k = 1; k <= maxLen; k++) lens.push(k);
    shuffleInPlace(lens);

    for (const len of lens) {
      if (results.length >= cap) return;
      const prefix = rem.substring(0, len);
      const cands = (indexByStress.get(prefix) || []).slice();
      shuffleInPlace(cands);
      for (const w of cands) {
        if (cur.length > 0 && cur[cur.length - 1].word === w.word) continue;
        if (bannedWords.has(w.word)) continue;
        cur.push(w);
        bt(rem.substring(len), cur, depth + 1);
        cur.pop();
      }
    }
  }
  bt(remaining, current, 1);
  return results;
}

/** Fisher–Yates shuffle in place */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/**
 * Грубый POS-фильтр по позиции слова в строке (подобие оригинального диспетчера).
 * Также блокирует «частицы» в последнем слоте строки — "не", "но", "и" в конце
 * строки убивают рифму (у них уникальный rhyme-ключ, рифмоваться не с чем).
 */
function passesPosFilter(words) {
  if (words.length === 0) return false;
  if (words.length === 1) {
    const p = words[0].pos || '';
    if (p === '?' || p === '') return false;
  }
  // После прилагательного должно идти существительное
  for (let i = 0; i < words.length - 1; i++) {
    const p = (words[i].pos || '').trim();
    if (p.startsWith('A')) {
      const next = (words[i+1].pos || '').trim();
      if (next !== 'N' && next !== 'AV') return false;
    }
  }
  // Последнее слово не должно быть частицей или 1-слоговым наречием
  // (иначе рифмовать строку не с чем — у частиц уникальный rhyme-ключ)
  const last = words[words.length - 1];
  const lastPos = (last.pos || '').trim();
  if (lastPos === '' || lastPos === '?') return false;
  return true;
}

/**
 * Главная функция: сочиняем стих по конфигу.
 *
 * @param {Array<Object>} dict  — массив записей словаря
 * @param {Array<{stress,rhyme}>} spec — спецификация строфы
 * @returns {string[]} — массив строк (по одной на строфу)
 */
function compose(dict, spec) {
  const lines = spec
    .filter(s => s.stress && canonStress(s.stress).length > 0)
    .map(s => ({ stress: canonStress(s.stress), rhyme: s.rhyme || '' }));

  if (lines.length === 0) return [];

  const indexByStress = buildIndex(dict);

  // Рифменные группы: буква → индексы строк
  const rhymeGroups = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].rhyme) continue;
    if (!rhymeGroups.has(lines[i].rhyme)) rhymeGroups.set(lines[i].rhyme, []);
    rhymeGroups.get(lines[i].rhyme).push(i);
  }

  let rngState = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
  function rng() {
    rngState = (rngState * 1103515245 + 12345) >>> 0;
    return (rngState >>> 16) & 0x7fff;
  }
  function pickRandom(arr) {
    if (!arr || arr.length === 0) return null;
    return arr[rng() % arr.length];
  }

  // ====== Проход 1: выбрать рифменный якорь для группы ======
  // Берём rhyme-ключ, который МОЖНО встретить как последнее слово в КАЖДОЙ
  // строке группы. Если такого нет — берём самый частый. Если и такого нет —
  // null (тогда рифма не навязывается, генерация идёт свободно).
  const groupAnchor = new Map();
  for (const [letter, lineIdxs] of rhymeGroups) {
    if (lineIdxs.length <= 1) continue;

    // Для каждой строки группы — множество rhyme-ключей её последних слов
    const keysByLine = lineIdxs.map(idx => {
      const decs = findDecompositions(lines[idx].stress, indexByStress, { cap: 60 })
                    .filter(passesPosFilter);
      const keys = new Set();
      for (const d of decs) if (d.length > 0) keys.add(d[d.length - 1].rhyme);
      return keys;
    });

    // 1) Пересечение — ключи, доступные ВСЕМ строкам группы
    const intersection = [...keysByLine[0]].filter(k => keysByLine.every(ks => ks.has(k)));
    let anchor = null;
    if (intersection.length > 0) {
      anchor = intersection[Math.floor(rng() % intersection.length)];
    } else {
      // 2) Самый частый (по числу строк, где встречается)
      const lineCount = new Map();
      for (const ks of keysByLine) {
        for (const k of ks) lineCount.set(k, (lineCount.get(k) || 0) + 1);
      }
      const sorted = [...lineCount.entries()].sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0 && sorted[0][1] >= 2) {
        anchor = sorted[0][0];
      }
    }
    if (anchor) groupAnchor.set(letter, anchor);
  }

  // ====== Проход 2: построить строки, отдавая предпочтение общей рифме ======
  // Используем скользящее окно «последние N слов» для бана — это сохраняет
  // разнообразие и не даёт зацикливаться на одной лексике.
  const recentWords = [];     // список последних ~24 слов
  const recentSet = new Set();
  const RECENT_LIMIT = 24;
  const result = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const letter = lines[i].rhyme;
    const target = (letter && groupAnchor.get(letter)) || null;

    let decs = findDecompositions(lines[i].stress, indexByStress, {
      bannedWords: recentSet, cap: 200,
    }).filter(passesPosFilter);

    if (decs.length === 0) {
      decs = findDecompositions(lines[i].stress, indexByStress, { cap: 200 }).filter(passesPosFilter);
    }

    // Отдадим предпочтение декомпозициям, чьё последнее слово рифмуется с якорем
    let pool = decs;
    if (target) {
      const matched = decs.filter(seq => seq.length > 0 && seq[seq.length - 1].rhyme === target);
      if (matched.length > 0) pool = matched;
    }

    if (pool.length === 0) { result[i] = `[нет: ${lines[i].stress}]`; continue; }
    const chosen = pickRandom(pool);
    result[i] = chosen.map(w => w.word).join(' ');
    // Обновим скользящее окно
    for (const w of chosen) {
      if (!recentSet.has(w.word)) {
        recentSet.add(w.word);
        recentWords.push(w.word);
        if (recentWords.length > RECENT_LIMIT) {
          const removed = recentWords.shift();
          recentSet.delete(removed);
        }
      }
    }
  }
  return result;
}

// ------------------------------------------------------------------
// ИНТЕРФЕЙС
// ------------------------------------------------------------------

const state = {
  dict: null,
  spec: null,        // {dictName,resName,lines:[]}
  outputLines: null,
  rememberedRow: null,
};

const $ = sel => document.querySelector(sel);
const els = {
  dictFile: $('#dictFile'),
  dictName: $('#dictName'),
  cfgFile: $('#cfgFile'),
  cfgName: $('#cfgName'),
  linesBody: $('#linesBody'),
  composeBtn: $('#composeBtn'),
  outputPre: $('#outputPre'),
  addBtn: $('#addBtn'),
  remBtn: $('#remBtn'),
  saveModeBtn: $('#saveModeBtn'),
  loadModeBtn: $('#loadModeBtn'),
  rememberBtn: $('#rememberBtn'),
  recallBtn: $('#recallBtn'),
  outFile: $('#outFile'),
  dlBtn: $('#dlBtn'),
};

// ---- словарь
els.dictFile.addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    state.dict = parseDictionary(buf);
    if (state.dict.length === 0) {
      els.dictName.innerHTML = `<span class="status err">${f.name}: 0 записей — формат не распознан</span>`;
    } else {
      els.dictName.innerHTML = `${f.name} <span class="status ok">${state.dict.length} слов</span>`;
    }
    refreshComposeButton();
  } catch (err) {
    els.dictName.innerHTML = `<span class="status err">${err.message}</span>`;
  }
});

// ---- конфиг
els.cfgFile.addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    state.spec = parseConfig(buf);
    els.cfgName.textContent = f.name;
    rebuildLinesTable();
    refreshComposeButton();
  } catch (err) {
    els.cfgName.innerHTML = `<span class="status err">${err.message}</span>`;
  }
});

// ---- таблица строк
function rebuildLinesTable() {
  if (!state.spec) return;
  const tbody = els.linesBody;
  tbody.innerHTML = '';
  state.spec.lines.forEach((line, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><input type="text" class="meter" value="${escapeHtml(line.stress)}" data-idx="${i}" data-field="stress"></td>
      <td><input type="text" class="rhyme" value="${escapeHtml(line.rhyme || '')}" maxlength="1" data-idx="${i}" data-field="rhyme"></td>
      <td class="skip-cell"><input type="checkbox" data-idx="${i}" data-field="skip"></td>
      <td></td>
    `;
    tbody.appendChild(tr);
  });
  tbody.addEventListener('input', onLineEdit, { once: false });
}
function onLineEdit(e) {
  const t = e.target;
  const idx = +t.dataset.idx;
  const field = t.dataset.field;
  if (!field || isNaN(idx)) return;
  if (field === 'stress') state.spec.lines[idx].stress = t.value;
  else if (field === 'rhyme') state.spec.lines[idx].rhyme = t.value;
  else if (field === 'skip') state.spec.lines[idx]._skip = t.checked;
  refreshComposeButton();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

els.addBtn.addEventListener('click', () => {
  if (!state.spec) state.spec = { dictName: 'rhymer.dat', resName: 'rhymer.res', lines: [] };
  if (state.spec.lines.length >= 14) return;
  state.spec.lines.push({ stress: "-'-", rhyme: '' });
  rebuildLinesTable();
});

// ---- пресеты размеров и рифм
//
// Метр: шаблон из '-' (безударный) и '\'' (ударный).
// Окончания:
//   мужское         — последний слог ударный (…′)
//   женское         — последний безударный (…-)
//   дактилическое   — два безударных в конце (…--)
//
// Классические размеры русского стиха:
//   ямб          -'                ударный через один с начала
//   хорей        '-                ударный с первого слога
//   дактиль      '--               ударный + два безударных
//   амфибрахий   -'-              безударный + ударный + безударный
//   анапест      --'              два безударных + ударный

const PRESETS = {
  // === Четверостишия ===
  'iamb4m-abab': {
    name: 'Ямб 4-стопный, мужское, ABAB',
    lines: [
      { stress: "-'-'-'-'-'", rhyme: 'a' },
      { stress: "-'-'-'-'-'", rhyme: 'b' },
      { stress: "-'-'-'-'-'", rhyme: 'a' },
      { stress: "-'-'-'-'-'", rhyme: 'b' },
    ],
  },
  'iamb4f-abab': {
    name: 'Ямб 4-стопный, женское, ABAB',
    lines: [
      { stress: "-'-'-'-'-", rhyme: 'a' },
      { stress: "-'-'-'-'-", rhyme: 'b' },
      { stress: "-'-'-'-'-", rhyme: 'a' },
      { stress: "-'-'-'-'-", rhyme: 'b' },
    ],
  },
  'iamb4f-aabb': {
    name: 'Ямб 4-стопный, женское, AABB',
    lines: [
      { stress: "-'-'-'-'-", rhyme: 'a' },
      { stress: "-'-'-'-'-", rhyme: 'a' },
      { stress: "-'-'-'-'-", rhyme: 'b' },
      { stress: "-'-'-'-'-", rhyme: 'b' },
    ],
  },
  'iamb3f-abab': {
    name: 'Ямб 3-стопный, женское, ABAB',
    lines: [
      { stress: "-'-'-'-", rhyme: 'a' },
      { stress: "-'-'-'-", rhyme: 'b' },
      { stress: "-'-'-'-", rhyme: 'a' },
      { stress: "-'-'-'-", rhyme: 'b' },
    ],
  },
  'iamb3mix-abab': {
    name: 'Ямб 3-стопный, чередование (как в примере «город поэтичный / просил мороз»)',
    lines: [
      { stress: "-'-'-'-",  rhyme: 'a' },   // 7 слогов, женское
      { stress: "-'-'-'-'", rhyme: 'b' },   // 6 слогов, мужское
      { stress: "-'-'-'-",  rhyme: 'a' },
      { stress: "-'-'-'-'", rhyme: 'b' },
    ],
  },
  'trochee4f-abab': {
    name: 'Хорей 4-стопный, женское, ABAB',
    lines: [
      { stress: "'-'-'-'-", rhyme: 'a' },
      { stress: "'-'-'-'-", rhyme: 'b' },
      { stress: "'-'-'-'-", rhyme: 'a' },
      { stress: "'-'-'-'-", rhyme: 'b' },
    ],
  },
  'trochee3m-abab': {
    name: 'Хорей 3-стопный, мужское, ABAB',
    lines: [
      { stress: "'-'-'-'", rhyme: 'a' },
      { stress: "'-'-'-'", rhyme: 'b' },
      { stress: "'-'-'-'", rhyme: 'a' },
      { stress: "'-'-'-'", rhyme: 'b' },
    ],
  },
  'dactyl3m-abab': {
    name: 'Дактиль 2-стопный, мужское, ABAB',
    lines: [
      { stress: "'--'--", rhyme: 'a' },
      { stress: "'--'--", rhyme: 'b' },
      { stress: "'--'--", rhyme: 'a' },
      { stress: "'--'--", rhyme: 'b' },
    ],
  },
  'dactyl2m-abab': {
    name: 'Дактиль 2-стопный, мужское, ABAB (6 слогов)',
    lines: [
      { stress: "'--'--", rhyme: 'a' },
      { stress: "'--'--", rhyme: 'b' },
      { stress: "'--'--", rhyme: 'a' },
      { stress: "'--'--", rhyme: 'b' },
    ],
  },
  'anapest2m-abab': {
    name: 'Анапест 2-стопный, мужское, ABAB (6 слогов)',
    lines: [
      { stress: "--'--'", rhyme: 'a' },
      { stress: "--'--'", rhyme: 'b' },
      { stress: "--'--'", rhyme: 'a' },
      { stress: "--'--'", rhyme: 'b' },
    ],
  },
  'anapest3m-abab': {
    name: 'Анапест 3-стопный, мужское, ABAB',
    lines: [
      { stress: "--'--'--'", rhyme: 'a' },
      { stress: "--'--'--'", rhyme: 'b' },
      { stress: "--'--'--'", rhyme: 'a' },
      { stress: "--'--'--'", rhyme: 'b' },
    ],
  },
  'amphibrach3m-abab': {
    name: 'Амфибрахий 3-стопный, мужское, ABAB',
    lines: [
      { stress: "-'-'-'-'", rhyme: 'a' },
      { stress: "-'-'-'-'", rhyme: 'b' },
      { stress: "-'-'-'-'", rhyme: 'a' },
      { stress: "-'-'-'-'", rhyme: 'b' },
    ],
  },

  // === Классические стансы ===
  'onegin': {
    name: 'Онегинская строфа',
    lines: [
      { stress: "-'-'-'-'-", rhyme: 'a' },   // 9 слогов, женское
      { stress: "-'-'-'-'",  rhyme: 'b' },   // 8 слогов, мужское
      { stress: "-'-'-'-'-", rhyme: 'a' },
      { stress: "-'-'-'-'",  rhyme: 'b' },
      { stress: "-'-'-'-'-", rhyme: 'c' },
      { stress: "-'-'-'-'-", rhyme: 'c' },   // парная рифма внутри терцета
      { stress: "-'-'-'-'",  rhyme: 'd' },
      { stress: "-'-'-'-'",  rhyme: 'd' },
      { stress: "-'-'-'-'-", rhyme: 'e' },
      { stress: "-'-'-'-'",  rhyme: 'f' },
      { stress: "-'-'-'-'",  rhyme: 'f' },
      { stress: "-'-'-'-'-", rhyme: 'e' },
      { stress: "-'-'-'-'",  rhyme: 'g' },
      { stress: "-'-'-'-'",  rhyme: 'g' },
    ],
  },
  'sonnet': {
    name: 'Сонет (Шекспиров: 3 катрена ABAB + 2 строки CC)',
    lines: [
      { stress: "-'-'-'-'-", rhyme: 'a' },
      { stress: "-'-'-'-'-", rhyme: 'b' },
      { stress: "-'-'-'-'-", rhyme: 'a' },
      { stress: "-'-'-'-'-", rhyme: 'b' },
      { stress: "-'-'-'-'-", rhyme: 'c' },
      { stress: "-'-'-'-'-", rhyme: 'd' },
      { stress: "-'-'-'-'-", rhyme: 'c' },
      { stress: "-'-'-'-'-", rhyme: 'd' },
      { stress: "-'-'-'-'-", rhyme: 'e' },
      { stress: "-'-'-'-'-", rhyme: 'f' },
      { stress: "-'-'-'-'-", rhyme: 'e' },
      { stress: "-'-'-'-'-", rhyme: 'f' },
      { stress: "-'-'-'-'-", rhyme: 'g' },
      { stress: "-'-'-'-'-", rhyme: 'g' },
    ],
  },
  'sestina': {
    name: 'Шестистишие (6-стопный ямб, ABABAB)',
    lines: [
      { stress: "-'-'-'-'-'-'", rhyme: 'a' },
      { stress: "-'-'-'-'-'-'", rhyme: 'b' },
      { stress: "-'-'-'-'-'-'", rhyme: 'c' },
      { stress: "-'-'-'-'-'-'", rhyme: 'a' },
      { stress: "-'-'-'-'-'-'", rhyme: 'b' },
      { stress: "-'-'-'-'-'-'", rhyme: 'c' },
    ],
  },

  'clear': { name: 'Очистить', lines: [] },
};

$('#applyPresetBtn').addEventListener('click', () => {
  const key = $('#presetSelect').value;
  if (!key) return;
  const preset = PRESETS[key];
  if (!preset) return;
  if (!state.spec) state.spec = { dictName: 'rhymer.dat', resName: 'rhymer.res', lines: [] };
  state.spec.lines = preset.lines.map(l => ({ ...l }));
  rebuildLinesTable();
  refreshComposeButton();
});
els.remBtn.addEventListener('click', () => {
  if (!state.spec || state.spec.lines.length === 0) return;
  state.spec.lines.pop();
  rebuildLinesTable();
  refreshComposeButton();
});

els.composeBtn.addEventListener('click', () => {
  if (!state.dict || !state.spec) return;
  // Уважаем _skip
  const filtered = state.spec.lines.map((l, i) => l._skip ? null : l).filter(Boolean);
  const lines = compose(state.dict, filtered);
  state.outputLines = lines;
  els.outputPre.textContent = (lines || []).join('\n') || '— не удалось —';
  els.dlBtn.disabled = !lines || lines.length === 0;
});

els.dlBtn.addEventListener('click', () => {
  if (!state.outputLines) return;
  const blob = new Blob([state.outputLines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = els.outFile.value || 'rhymer.out';
  a.click();
  URL.revokeObjectURL(a.href);
});

els.rememberBtn.addEventListener('click', () => {
  if (!state.outputLines) return;
  state.rememberedRow = state.outputLines.slice();
  els.recallBtn.disabled = false;
});
els.recallBtn.addEventListener('click', () => {
  if (!state.rememberedRow) return;
  els.outputPre.textContent = state.rememberedRow.join('\n');
});

els.saveModeBtn.addEventListener('click', () => {
  if (!state.spec) return;
  // Сохраняем в формате оригинала: 20 + 20 + N*25 байт CP866
  let payload = '';
  payload += state.spec.dictName.padEnd(20, ' ').slice(0, 20);
  payload += state.spec.resName.padEnd(20, ' ').slice(0, 20);
  for (const line of state.spec.lines) {
    const stress = (line.stress || '').padEnd(19, ' ').slice(0, 19);
    const rhyme = line.rhyme || ' ';
    payload += stress + rhyme.slice(-1);
  }
  // дополним пробелами до 570 байт как в оригинале
  while (payload.length < 570) payload += ' ';
  const bytes = new TextEncoder().encode(payload); // UTF-8 — для удобства чтения
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'rhymer.cfg';
  a.click();
  URL.revokeObjectURL(a.href);
});

els.loadModeBtn.addEventListener('click', () => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.cfg';
  inp.onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    state.spec = parseConfig(await f.arrayBuffer());
    rebuildLinesTable();
    refreshComposeButton();
  };
  inp.click();
});

function refreshComposeButton() {
  els.composeBtn.disabled = !(state.dict && state.spec && state.spec.lines.length > 0);
}

// ---- ленивая загрузка локальных файлов при наличии
(async () => {
  // пробуем автоматически подхватить rhymer.dat и onegin.cfg, если они рядом
  // (работает только при file:// доступе к текущей директории или через http).
  try {
    if (!state.dict) {
      const r = await fetch('rhymer.dat');
      if (r.ok) {
        const buf = await r.arrayBuffer();
        state.dict = parseDictionary(buf);
        if (state.dict.length > 0) {
          els.dictName.innerHTML = `rhymer.dat <span class="status ok">${state.dict.length} слов</span>`;
        } else {
          els.dictName.innerHTML = `rhymer.dat <span class="status err">0 слов — формат не распознан</span>`;
        }
      } else {
        els.dictName.innerHTML = `rhymer.dat <span class="status err">не найден (HTTP ${r.status})</span>`;
      }
    }
  } catch (err) {
    els.dictName.innerHTML = `rhymer.dat <span class="status err">не загружен</span> · выберите файл выше`;
  }
  try {
    if (!state.spec) {
      const r = await fetch('onegin.cfg');
      if (r.ok) {
        const buf = await r.arrayBuffer();
        state.spec = parseConfig(buf);
        els.cfgName.innerHTML = `onegin.cfg <span class="status ok">${state.spec.lines.length} строк</span>`;
        rebuildLinesTable();
      } else {
        els.cfgName.innerHTML = `onegin.cfg <span class="status err">не найден (HTTP ${r.status})</span>`;
      }
    }
  } catch {
    els.cfgName.innerHTML = `onegin.cfg <span class="status err">не загружен</span> · выберите файл выше`;
  }
  refreshComposeButton();
})();
