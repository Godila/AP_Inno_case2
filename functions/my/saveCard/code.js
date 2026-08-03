// Инструмент агента: сохранить услышанные параметры в карточку и пересчитать цену.
// Файл целиком уезжает в пользовательскую функцию saveCard коллекции my.
// Параметры функции доступны как переменные верхнего уровня.
//
// Диалог ведет блок Агент: он решает, что спросить дальше, опираясь на missing.
// Здесь только детерминированная часть - слияние карточки и арифметика цены.
//
// Тариф лежит в базе проекта документом tariff и правится без выкладки кода.
// Если документа нет, функция кладет туда значения по умолчанию.
// Чтобы вернуть тариф к исходному, документ достаточно удалить: Db.delete.

var CARD_KEY = "card";
var TARIFF_KEY = "tariff";
var DB_INTEGRATION = "1000156248-my-joz";

var PRIORITY = [
  "type", "area", "wall_material", "year",
  "roof_material", "floors", "address", "owner"
];

var REQUIRED_FOR_PRICE = ["type", "area", "wall_material", "year"];

// Ступени по году идут сверху вниз: берется первая, у которой from не больше года.
function defaultTariff() {
  return {
    base: 100,
    wall: {
      "кирпич": 1.0, "блок": 1.0, "металл": 1.0,
      "брус": 1.15, "бревно": 1.2, "каркас": 1.3
    },
    roof: {
      "металлочерепица": 1.0, "профнастил": 1.0,
      "шифер": 1.1, "мягкая кровля": 1.15, "дерево": 1.25
    },
    year: [
      { from: 2016, k: 1.0 },
      { from: 2000, k: 1.1 },
      { from: 1980, k: 1.2 },
      { from: 0, k: 1.3 }
    ],
    floors: { from: 3, k: 1.1 }
  };
}

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

function missingFields(card) {
  return PRIORITY.filter(function (field) {
    return !isFilled(card[field]);
  });
}

// Документ из базы приходит либо как есть, либо обернутым в поле value -
// контракт функции этого не уточняет, поэтому принимаем оба варианта.
function documentValue(document) {
  if (!document || typeof document !== "object") {
    return null;
  }
  return document.value && typeof document.value === "object" ? document.value : document;
}

function cardFromDocument(document) {
  var source = documentValue(document);
  if (!source) {
    return null;
  }
  for (var i = 0; i < PRIORITY.length; i++) {
    if (Object.prototype.hasOwnProperty.call(source, PRIORITY[i])) {
      return source;
    }
  }
  return null;
}

// Битый тариф не должен ронять расчет: такой документ игнорируется и не перезаписывается.
function tariffFromDocument(document) {
  var source = documentValue(document);
  if (!source) {
    return null;
  }
  var ok = typeof source.base === "number" &&
    source.wall && typeof source.wall === "object" &&
    source.roof && typeof source.roof === "object" &&
    Array.isArray(source.year) && source.year.length > 0 &&
    source.floors && typeof source.floors === "object";
  return ok ? source : null;
}

function yearK(year, steps) {
  for (var i = 0; i < steps.length; i++) {
    if (year >= steps[i].from) {
      return steps[i].k;
    }
  }
  return 1.0;
}

function floorsK(floors, rule) {
  if (floors === null || floors === undefined) {
    return 1.0;
  }
  return floors >= rule.from ? rule.k : 1.0;
}

function calcPrice(card, tariff) {
  var rates = tariff || defaultTariff();
  var hasAll = REQUIRED_FOR_PRICE.every(function (field) {
    return isFilled(card[field]);
  });
  if (!hasAll) {
    return { value: null, preliminary: true, breakdown: null };
  }

  var breakdown = {
    base: rates.base,
    area: card.area,
    k_wall: rates.wall[card.wall_material] != null ? rates.wall[card.wall_material] : 1.0,
    k_year: yearK(card.year, rates.year),
    k_roof: isFilled(card.roof_material) && rates.roof[card.roof_material] != null ? rates.roof[card.roof_material] : 1.0,
    k_floors: floorsK(card.floors, rates.floors)
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

function buildPayload(card, tariff, meta) {
  var missing = missingFields(card);
  var extra = meta || {};
  return {
    card: card,
    missing: missing,
    price: calcPrice(card, tariff),
    isComplete: missing.length === 0,
    stored: extra.stored === true,
    tariffSource: extra.tariffSource || "defaults"
  };
}

function readTariff() {
  var document = Db.get({ dbIntegration: DB_INTEGRATION, documentKey: TARIFF_KEY });
  var tariff = tariffFromDocument(document);
  if (tariff) {
    return { tariff: tariff, source: "db" };
  }
  if (document) {
    Log.warn({ message: "Тариф в базе не читается, считаю по умолчанию", data: { document: document } });
    return { tariff: defaultTariff(), source: "defaults" };
  }
  var seeded = defaultTariff();
  Db.put({ dbIntegration: DB_INTEGRATION, documentKey: TARIFF_KEY, value: seeded });
  return { tariff: seeded, source: "seeded" };
}

// Карточка едет на страницу отдельным сообщением: страница вынимает JSON-блок
// из любой реплики, а текст вопроса берет из ответа агента.
function run(heard) {
  var stored = cardFromDocument(SessionDb.get({ documentKey: CARD_KEY }));
  var merged = mergeCard(stored || emptyCard(), heard);
  SessionDb.put({ documentKey: CARD_KEY, value: merged });

  var rates = readTariff();
  var payload = buildPayload(merged, rates.tariff, {
    stored: stored !== null,
    tariffSource: rates.source
  });

  Log.info({ message: "Карточка обновлена", data: payload });
  Reactions.sendText({ text: "```json\n" + JSON.stringify(payload) + "\n```" });

  return payload;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    defaultTariff: defaultTariff,
    emptyCard: emptyCard,
    mergeCard: mergeCard,
    missingFields: missingFields,
    calcPrice: calcPrice,
    buildPayload: buildPayload,
    cardFromDocument: cardFromDocument,
    tariffFromDocument: tariffFromDocument
  };
} else {
  return run({
    type: type,
    area: area,
    wall_material: wall_material,
    year: year,
    roof_material: roof_material,
    floors: floors,
    address: address,
    owner: owner
  });
}
