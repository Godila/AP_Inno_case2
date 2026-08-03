// Инструмент андеррайтера: собрать риск-профиль и вынести решение по заявке.
// Файл целиком уезжает в пользовательскую функцию assessRisk коллекции my.
// Параметры функции доступны как переменные верхнего уровня.
//
// Правила андеррайтинга лежат в базе проекта документом underwriting, рядом с тарифом,
// и правятся без выкладки кода. Копии правил в коде нет намеренно, как и с тарифом:
// нет документа или он испорчен - решение unavailable, полис не выпускается.
// Молча пропустить объект без проверки хуже, чем не выпустить полис.
// Эталонное содержимое документа: ap/underwriting.json.

var CARD_KEY = "card";
var PRICE_KEY = "price";
var RISK_KEY = "risk";
var ASSESSMENT_KEY = "assessment";
var RULES_KEY = "underwriting";
var TARIFF_KEY = "tariff";
var DB_INTEGRATION = "1000156248-my-joz";

var RISK_FIELDS = ["heating", "security", "occupancy"];
var RULE_SECTIONS = ["decline", "escalate", "surcharge", "discount"];

function isFilled(value) {
  return value !== null && value !== undefined && value !== "";
}

function documentValue(document) {
  if (!document || typeof document !== "object") {
    return null;
  }
  return document.value && typeof document.value === "object" ? document.value : document;
}

function mergeRisk(current, heard) {
  var result = {};
  for (var i = 0; i < RISK_FIELDS.length; i++) {
    var field = RISK_FIELDS[i];
    result[field] = current && isFilled(current[field]) ? current[field] : null;
    if (heard && isFilled(heard[field])) {
      result[field] = heard[field];
    }
  }
  return result;
}

function missingRisk(risk) {
  return RISK_FIELDS.filter(function (field) {
    return !risk || !isFilled(risk[field]);
  });
}

function riskFromDocument(document) {
  var source = documentValue(document);
  if (!source) {
    return null;
  }
  for (var i = 0; i < RISK_FIELDS.length; i++) {
    if (Object.prototype.hasOwnProperty.call(source, RISK_FIELDS[i])) {
      return source;
    }
  }
  return null;
}

// Правило срабатывает, только если выполнено условие применимости when:
// им описываются проверки на правдоподобие вроде бани в триста квадратов.
function matches(rule, subject) {
  if (rule.when) {
    var keys = Object.keys(rule.when);
    for (var i = 0; i < keys.length; i++) {
      if (subject[keys[i]] !== rule.when[keys[i]]) {
        return false;
      }
    }
  }
  var value = subject[rule.field];
  if (!isFilled(value)) {
    return false;
  }
  if (rule.op === "lt") {
    return typeof value === "number" && value < rule.value;
  }
  if (rule.op === "gt") {
    return typeof value === "number" && value > rule.value;
  }
  if (rule.op === "in") {
    return Array.isArray(rule.value) && rule.value.indexOf(value) !== -1;
  }
  return false;
}

function isValidRules(source) {
  return RULE_SECTIONS.every(function (section) {
    return Array.isArray(source[section]);
  });
}

// Три состояния, как у тарифа: Db.get на пустом ключе возвращает служебную обертку,
// поэтому отсутствие документа определяется по составу данных, а не по null.
function classifyRules(document) {
  var source = documentValue(document);
  var keys = source ? Object.keys(source) : null;
  var known = source && RULE_SECTIONS.some(function (section) {
    return Object.prototype.hasOwnProperty.call(source, section);
  });
  if (!known) {
    return { state: "absent", rules: null, keys: keys };
  }
  return isValidRules(source)
    ? { state: "ok", rules: source, keys: null }
    : { state: "broken", rules: null, keys: keys };
}

function fired(rules, subject) {
  return rules.filter(function (rule) {
    return matches(rule, subject);
  });
}

function coverage(card, tariff) {
  var rates = tariff && tariff.sumPerMeter ? tariff.sumPerMeter : null;
  var perMeter = rates && isFilled(card.wall_material) ? rates[card.wall_material] : null;
  if (!isFilled(card.area) || perMeter == null) {
    return { sumInsured: null, franchise: null };
  }
  var sumInsured = Math.round(card.area * perMeter);
  var rate = typeof tariff.franchiseRate === "number" ? tariff.franchiseRate : 0;
  return { sumInsured: sumInsured, franchise: Math.round(sumInsured * rate) };
}

function verdict(decision, reasons, basePrice, cover, extra) {
  var result = {
    decision: decision,
    reasons: reasons,
    basePrice: basePrice === undefined ? null : basePrice,
    price: null,
    totalK: null,
    sumInsured: cover.sumInsured,
    franchise: cover.franchise,
    missing: []
  };
  return Object.assign(result, extra || {});
}

// Порядок проверки: сначала отказы, потом эскалации, потом коэффициенты.
// Скидки и надбавки перемножаются, а не складываются: так порядок правил
// не влияет на результат.
function assess(card, risk, rules, basePrice, tariff) {
  var cover = coverage(card, tariff);
  var absent = missingRisk(risk);
  if (absent.length) {
    return verdict("incomplete", [], basePrice, cover, { missing: absent });
  }
  if (typeof basePrice !== "number") {
    return verdict("unavailable", [], null, cover);
  }

  var subject = Object.assign({}, card, risk);

  var declined = fired(rules.decline, subject);
  if (declined.length) {
    return verdict("declined", declined.map(function (rule) {
      return { reason: rule.reason };
    }), basePrice, cover);
  }

  var escalated = fired(rules.escalate, subject);
  if (escalated.length) {
    return verdict("escalated", escalated.map(function (rule) {
      return { reason: rule.reason };
    }), basePrice, cover);
  }

  var applied = fired(rules.surcharge, subject).concat(fired(rules.discount, subject));
  var product = applied.reduce(function (total, rule) {
    return total * rule.k;
  }, 1);

  return verdict("accepted", applied.map(function (rule) {
    return { reason: rule.reason, k: rule.k };
  }), basePrice, cover, {
    price: Math.round(basePrice * product),
    totalK: Math.round(product * 10000) / 10000
  });
}

function readDocument(key, classify, label) {
  var found = classify(Db.get({ dbIntegration: DB_INTEGRATION, documentKey: key }));
  if (found.state !== "ok") {
    Log.error({ message: label + " в базе не настроен", data: { state: found.state, keys: found.keys } });
  }
  return found;
}

function classifyTariff(document) {
  var source = documentValue(document);
  var keys = source ? Object.keys(source) : null;
  var known = source && Object.prototype.hasOwnProperty.call(source, "sumPerMeter");
  if (!known) {
    return { state: "absent", rules: null, keys: keys };
  }
  return { state: "ok", rules: source, keys: null };
}

function run(heard) {
  var card = documentValue(SessionDb.get({ documentKey: CARD_KEY })) || {};
  var price = documentValue(SessionDb.get({ documentKey: PRICE_KEY }));
  var basePrice = price && typeof price.value === "number" ? price.value : null;

  var risk = mergeRisk(riskFromDocument(SessionDb.get({ documentKey: RISK_KEY })), heard);
  SessionDb.put({ documentKey: RISK_KEY, value: risk });

  var rules = readDocument(RULES_KEY, classifyRules, "Правила андеррайтинга");
  var tariff = readDocument(TARIFF_KEY, classifyTariff, "Тариф");

  var result = rules.state === "ok"
    ? assess(card, risk, rules.rules, basePrice, tariff.rules)
    : verdict("unavailable", [], basePrice, { sumInsured: null, franchise: null });

  var payload = Object.assign({ stage: "risk", risk: risk }, result);
  SessionDb.put({ documentKey: ASSESSMENT_KEY, value: result });

  Log.info({ message: "Решение андеррайтера", data: payload });
  Reactions.sendText({ text: "```json\n" + JSON.stringify(payload) + "\n```" });

  return payload;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    mergeRisk: mergeRisk,
    missingRisk: missingRisk,
    matches: matches,
    classifyRules: classifyRules,
    assess: assess
  };
} else {
  return run({
    heating: heating,
    security: security,
    occupancy: occupancy
  });
}
