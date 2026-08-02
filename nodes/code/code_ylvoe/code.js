// Один ход диалога голосового помощника страхового агента.
// Файл целиком уезжает в блок Код проекта Agents Platform.
// Хелперы чистые и покрыты тестами (ap/dialog-turn.test.js),
// работа с платформой начинается в main().

// Блок Код ограничен примерно 16 секундами, поэтому извлечение идет на flash-модели.
var LLM_MODEL_KEY = "1000156248-deepseek_deepseekv4f-flh";
var ASR_INTEGRATION_KEY = ""; // подставить ключ интеграции Модель ASR
var CARD_KEY = "card";
var STATE_KEY = "dialogState";

var PRIORITY = [
  "type", "area", "wall_material", "year",
  "roof_material", "floors", "address", "owner"
];

var QUESTIONS = {
  type: "Какой объект страхуем: дом, дача, коттедж или баня?",
  area: "Какая площадь объекта в квадратных метрах?",
  wall_material: "Из чего построены стены?",
  year: "Какой год постройки?",
  roof_material: "Чем покрыта крыша?",
  floors: "Сколько этажей?",
  address: "Какой адрес объекта?",
  owner: "Кто собственник?"
};

var RETRY_QUESTIONS = {
  type: "Уточните тип объекта: дом, дача, коттедж или баня?",
  area: "Повторите площадь в квадратных метрах, пожалуйста.",
  wall_material: "Повторите материал стен: бревно, брус, кирпич, блок или каркас?",
  year: "Назовите год постройки числом, например 2015.",
  roof_material: "Повторите материал кровли: металлочерепица, профнастил, шифер, мягкая кровля или дерево?",
  floors: "Сколько этажей в объекте, назовите числом.",
  address: "Продиктуйте адрес объекта.",
  owner: "Назовите ФИО собственника."
};

var MAX_ATTEMPTS = 2;

var EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "area", "wall_material", "roof_material", "year", "floors", "address", "owner"],
  properties: {
    type: { type: ["string", "null"], enum: ["дом", "дача", "коттедж", "баня", null] },
    area: { type: ["number", "null"] },
    wall_material: { type: ["string", "null"], enum: ["бревно", "брус", "кирпич", "блок", "каркас", "металл", null] },
    roof_material: { type: ["string", "null"], enum: ["металлочерепица", "профнастил", "шифер", "мягкая кровля", "дерево", null] },
    year: { type: ["integer", "null"] },
    floors: { type: ["integer", "null"] },
    address: { type: ["string", "null"] },
    owner: { type: ["string", "null"] }
  }
};

var EXTRACTION_PROMPT = [
  "Ты помощник страхового агента по загородной недвижимости.",
  "Извлеки параметры объекта страхования из реплики агента.",
  "",
  "Правила:",
  "- Заполняй только то, что прозвучало в этой реплике. Всё остальное - null.",
  "- Ничего не додумывай. Если параметр назван неоднозначно и вариантов больше одного - null.",
  "- Числа словами переводи в цифры: \"сто двадцать квадратов\" -> area 120.",
  "- Разговорные названия приводи к допустимым значениям:",
  "  \"железная крыша\", \"железо\", \"оцинковка\", \"металлопрофиль\" -> профнастил;",
  "  \"рубероид\", \"битумная черепица\" -> мягкая кровля;",
  "  \"сруб\", \"круглый лес\" -> бревно;",
  "  \"пеноблок\", \"газобетон\", \"газоблок\" -> блок;",
  "  \"щитовой\", \"каркасник\" -> каркас.",
  "- Оценочные слова о возрасте (\"старый\", \"недавно построен\") в год постройки не превращай, оставь null.",
  "- Адрес собирай одной строкой в том виде, как он произнесен.",
  "- Собственника записывай как ФИО одной строкой."
].join("\n");

var BASE_RATE = 100;

var WALL_K = {
  "кирпич": 1.0, "блок": 1.0, "металл": 1.0,
  "брус": 1.15, "бревно": 1.2, "каркас": 1.3
};

var ROOF_K = {
  "металлочерепица": 1.0, "профнастил": 1.0,
  "шифер": 1.1, "мягкая кровля": 1.15, "дерево": 1.25
};

var REQUIRED_FOR_PRICE = ["type", "area", "wall_material", "year"];

function emptyCard() {
  var card = {};
  for (var i = 0; i < PRIORITY.length; i++) {
    card[PRIORITY[i]] = null;
  }
  return card;
}

function isFilled(value) {
  return value !== null && value !== undefined && value !== "";
}

function mergeCard(current, extracted) {
  var result = {};
  for (var i = 0; i < PRIORITY.length; i++) {
    var field = PRIORITY[i];
    result[field] = current && isFilled(current[field]) ? current[field] : null;
    if (extracted && isFilled(extracted[field])) {
      result[field] = extracted[field];
    }
  }
  return result;
}

function missingFields(card, deferred) {
  var skip = deferred || [];
  return PRIORITY.filter(function (field) {
    return !isFilled(card[field]) && skip.indexOf(field) === -1;
  });
}

function nextQuestionField(card, deferred) {
  var missing = missingFields(card, deferred);
  return missing.length ? missing[0] : null;
}

function registerAttempt(state, field) {
  var attempts = {};
  for (var key in state.attempts) {
    attempts[key] = state.attempts[key];
  }
  var deferred = state.deferred.slice();
  attempts[field] = (attempts[field] || 0) + 1;
  if (attempts[field] >= MAX_ATTEMPTS && deferred.indexOf(field) === -1) {
    deferred.push(field);
  }
  return { attempts: attempts, deferred: deferred };
}

function yearK(year) {
  if (year > 2015) return 1.0;
  if (year >= 2000) return 1.1;
  if (year >= 1980) return 1.2;
  return 1.3;
}

function floorsK(floors) {
  if (floors === null || floors === undefined) return 1.0;
  return floors >= 3 ? 1.1 : 1.0;
}

function calcPrice(card) {
  var hasAll = REQUIRED_FOR_PRICE.every(function (field) {
    return isFilled(card[field]);
  });
  if (!hasAll) {
    return { value: null, preliminary: true, breakdown: null };
  }

  var breakdown = {
    base: BASE_RATE,
    area: card.area,
    k_wall: WALL_K[card.wall_material] != null ? WALL_K[card.wall_material] : 1.0,
    k_year: yearK(card.year),
    k_roof: isFilled(card.roof_material) && ROOF_K[card.roof_material] != null ? ROOF_K[card.roof_material] : 1.0,
    k_floors: floorsK(card.floors)
  };

  var value = Math.round(
    breakdown.area * breakdown.base *
    breakdown.k_wall * breakdown.k_year * breakdown.k_roof * breakdown.k_floors
  );

  return {
    value: value,
    preliminary: !isFilled(card.roof_material) || !isFilled(card.floors),
    breakdown: breakdown
  };
}

function questionFor(field, attempts) {
  if (!field) return null;
  var asked = attempts && attempts[field] ? attempts[field] : 0;
  return asked > 0 ? RETRY_QUESTIONS[field] : QUESTIONS[field];
}

function summaryText(card, price) {
  var amount = price.value === null ? "не рассчитана" : price.value.toLocaleString("ru-RU") + " руб";
  return "Карточка собрана. Объект: " + card.type + ", " + card.area + " кв.м, стены " +
    card.wall_material + ", " + card.year + " год. Стоимость полиса: " + amount + ".";
}

function buildPayload(card, deferred, question) {
  var price = calcPrice(card);
  var missing = missingFields(card, []);
  return {
    card: card,
    missing: missing,
    deferred: deferred,
    price: price,
    question: question,
    isComplete: missing.length === 0
  };
}

function renderReply(payload) {
  var text = payload.question || summaryText(payload.card, payload.price);
  return text + "\n```json\n" + JSON.stringify(payload) + "\n```";
}

function parseInput(rawRequest, query) {
  var data = rawRequest && rawRequest.data ? rawRequest.data : null;
  if (data && data.audioUrl) {
    return { audioUrl: data.audioUrl, text: null };
  }
  var text = typeof query === "string" ? query : "";
  var match = text.match(/^\[audio\]\s*(\S+)\s*$/);
  if (match) {
    return { audioUrl: match[1], text: null };
  }
  return { audioUrl: null, text: text };
}

function extractedFromLlm(response) {
  if (!response || typeof response.text !== "string") {
    return null;
  }
  var text = response.text.trim();
  var fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (fenced) {
    text = fenced[1].trim();
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function main() {
  var raw = Context.getRawRequest();
  var content = Context.getMessageContent();
  var input = parseInput(raw, content && content.text ? content.text : "");

  var stored = SessionDb.get({ documentKey: CARD_KEY });
  var card = stored && stored.value ? stored.value : emptyCard();
  var storedState = SessionDb.get({ documentKey: STATE_KEY });
  var state = storedState && storedState.value ? storedState.value : { attempts: {}, deferred: [] };

  var text = input.text;
  if (input.audioUrl) {
    var recognized = Asr.recognize({
      asrIntegrationKey: ASR_INTEGRATION_KEY,
      audioUrl: input.audioUrl
    });
    text = recognized && recognized.result ? recognized.result.text : "";
    Log.info({ message: "Распознано", data: { text: text } });
  }

  if (!text) {
    var payloadEmpty = buildPayload(card, state.deferred, questionFor(nextQuestionField(card, state.deferred), state.attempts));
    Reactions.sendText({ text: "Не расслышал, повторите пожалуйста.\n```json\n" + JSON.stringify(payloadEmpty) + "\n```" });
    return payloadEmpty;
  }

  var llm = Llm.sendRequest({
    llmModelKey: LLM_MODEL_KEY,
    messages: [
      { role: "system", text: EXTRACTION_PROMPT },
      { role: "user", text: text }
    ],
    responseFormat: EXTRACTION_SCHEMA,
    temperature: 0,
    maxCompletionTokens: 400
  });

  var extracted = extractedFromLlm(llm);
  Log.info({ message: "Извлечено", data: { extracted: extracted } });

  var askedField = nextQuestionField(card, state.deferred);
  var merged = mergeCard(card, extracted);
  var gotAnswer = askedField ? isFilled(merged[askedField]) : true;
  if (askedField && !gotAnswer) {
    state = registerAttempt(state, askedField);
  }

  var nextField = nextQuestionField(merged, state.deferred);
  var payload = buildPayload(merged, state.deferred, questionFor(nextField, state.attempts));

  SessionDb.put({ documentKey: CARD_KEY, value: merged });
  SessionDb.put({ documentKey: STATE_KEY, value: state });

  Reactions.sendText({ text: renderReply(payload) });
  return payload;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    emptyCard: emptyCard,
    mergeCard: mergeCard,
    missingFields: missingFields,
    nextQuestionField: nextQuestionField,
    registerAttempt: registerAttempt,
    calcPrice: calcPrice,
    questionFor: questionFor,
    buildPayload: buildPayload,
    renderReply: renderReply,
    parseInput: parseInput,
    extractedFromLlm: extractedFromLlm,
    EXTRACTION_SCHEMA: EXTRACTION_SCHEMA
  };
} else {
  main();
}
