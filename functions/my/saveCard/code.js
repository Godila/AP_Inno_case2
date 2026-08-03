// Инструмент агента: сохранить услышанные параметры в карточку и пересчитать цену.
// Файл целиком уезжает в пользовательскую функцию saveCard коллекции my.
// Параметры функции доступны как переменные верхнего уровня.
//
// Диалог ведет блок Агент: он решает, что спросить дальше, опираясь на missing.
// Здесь только детерминированная часть - слияние карточки и арифметика цены.

var CARD_KEY = "card";

var PRIORITY = [
  "type", "area", "wall_material", "year",
  "roof_material", "floors", "address", "owner"
];

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

function missingFields(card) {
  return PRIORITY.filter(function (field) {
    return !isFilled(card[field]);
  });
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

function buildPayload(card, stored) {
  var missing = missingFields(card);
  return {
    card: card,
    missing: missing,
    price: calcPrice(card),
    isComplete: missing.length === 0,
    stored: stored === true
  };
}

// Документ из SessionDb приходит либо как есть, либо обернутым в поле value -
// контракт функции этого не уточняет, поэтому принимаем оба варианта.
function cardFromDocument(document) {
  if (!document || typeof document !== "object") {
    return null;
  }
  var source = document.value && typeof document.value === "object" ? document.value : document;
  for (var i = 0; i < PRIORITY.length; i++) {
    if (Object.prototype.hasOwnProperty.call(source, PRIORITY[i])) {
      return source;
    }
  }
  return null;
}

// Карточка едет на страницу отдельным сообщением: страница вынимает JSON-блок
// из любой реплики, а текст вопроса берет из ответа агента.
function run(heard) {
  var document = SessionDb.get({ documentKey: CARD_KEY });
  var stored = cardFromDocument(document);
  var merged = mergeCard(stored || emptyCard(), heard);

  SessionDb.put({ documentKey: CARD_KEY, value: merged });

  var payload = buildPayload(merged, stored !== null);
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
    cardFromDocument: cardFromDocument
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
