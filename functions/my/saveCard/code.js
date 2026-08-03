// Инструмент агента: сохранить услышанные параметры в карточку и пересчитать цену.
// Файл целиком уезжает в пользовательскую функцию saveCard коллекции my.
// Параметры функции доступны как переменные верхнего уровня.
//
// Диалог ведет блок Агент: он решает, что спросить дальше, опираясь на missing.
// Здесь только детерминированная часть - слияние карточки и арифметика цены.
//
// Тариф лежит в базе проекта документом tariff и правится без выкладки кода.
// Копии ставок в коде нет намеренно: захардкоженный запасной тариф молча подменял бы
// настройку и расходился с ней. Нет документа или он испорчен - цена не считается,
// в карточке видно почему. Эталонное содержимое документа: ap/tariff.json.

var CARD_KEY = "card";
var TARIFF_KEY = "tariff";
var DB_INTEGRATION = "1000156248-my-joz";

var PRIORITY = [
  "type", "area", "wall_material", "year",
  "roof_material", "floors", "address", "owner"
];

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

var TARIFF_FIELDS = ["base", "wall", "roof", "year", "floors"];

function isValidTariff(source) {
  return typeof source.base === "number" &&
    source.wall && typeof source.wall === "object" &&
    source.roof && typeof source.roof === "object" &&
    Array.isArray(source.year) && source.year.length > 0 &&
    source.floors && typeof source.floors === "object";
}

// Три состояния, а не два. Db.get на пустом ключе возвращает служебную обертку
// {key, value, createdAt, updatedAt} вместо null, поэтому отсутствие документа
// определяется по составу данных. Испорченным считается документ, где тарифные
// поля есть, но не сходятся: в карточке это видно отдельным состоянием.
function classifyTariff(document) {
  var source = documentValue(document);
  var keys = source ? Object.keys(source) : null;
  var known = source && TARIFF_FIELDS.some(function (field) {
    return Object.prototype.hasOwnProperty.call(source, field);
  });
  if (!known) {
    return { state: "absent", tariff: null, keys: keys };
  }
  return isValidTariff(source)
    ? { state: "ok", tariff: source, keys: null }
    : { state: "broken", tariff: null, keys: keys };
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
  var rates = tariff;
  var hasAll = rates && REQUIRED_FOR_PRICE.every(function (field) {
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
    tariffSource: extra.tariffSource || "absent",
    tariffDoc: extra.tariffDoc || null
  };
}

function readTariff() {
  var document = Db.get({ dbIntegration: DB_INTEGRATION, documentKey: TARIFF_KEY });
  var found = classifyTariff(document);

  if (found.state === "ok") {
    return { tariff: found.tariff, source: "db", keys: null };
  }

  Log.error({
    message: "Тариф в базе не настроен, цена не считается",
    data: { state: found.state, keys: found.keys }
  });
  return { tariff: null, source: found.state, keys: found.keys };
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
    tariffSource: rates.source,
    tariffDoc: rates.keys
  });

  Log.info({ message: "Карточка обновлена", data: payload });
  Reactions.sendText({ text: "```json\n" + JSON.stringify(payload) + "\n```" });

  return payload;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    emptyCard: emptyCard,
    mergeCard: mergeCard,
    missingFields: missingFields,
    calcPrice: calcPrice,
    buildPayload: buildPayload,
    cardFromDocument: cardFromDocument,
    classifyTariff: classifyTariff
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
