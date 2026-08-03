// Временный узел-спайк, итерация 2.
//
// Что уже выяснено первой итерацией:
// - npm-пакет отдается готовой переменной по code-name, require в песочнице нет;
// - встроенные функции становятся асинхронными в коллекции с зависимостями
//   (коллекции без зависимостей это не затрагивает);
// - lib.createPdf отсутствует, значит переменная не тот объект, что отдает пакет в Node.
//
// Эта итерация снимает слепок переменной и перебирает способы добраться до шрифтов.
// Каждая попытка пишется в attempts со своей ошибкой, чтобы одного прогона хватило.

function describe(value) {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value !== "object" && typeof value !== "function") {
    return typeof value;
  }
  var keys = [];
  try {
    keys = Object.keys(value).slice(0, 25);
  } catch (error) {
    keys = ["<не перечисляется>"];
  }
  return typeof value + ": " + keys.join(",");
}

async function tryRender(lib, fonts, label, attempts) {
  try {
    if (fonts) {
      await lib.addFonts(fonts);
    }
    var started = Date.now();
    var buffer = await lib.createPdf({
      defaultStyle: { font: "Roboto", fontSize: 11 },
      content: [{ text: "Проверка кириллицы: дача, бревно, Иванов Пётр" }]
    }).getBuffer();
    var base64 = typeof buffer.toString === "function"
      ? buffer.toString("base64")
      : Buffer.from(buffer).toString("base64");
    attempts.push(label + ": ok " + (Date.now() - started) + "ms " + Math.round(base64.length / 1024) + "kb " + base64.slice(0, 5));
    return base64;
  } catch (error) {
    attempts.push(label + ": " + (error && error.message ? error.message : String(error)).slice(0, 120));
    return null;
  }
}

async function probe() {
  var report = { spike: "pdfmake-2", raw: null, lib: null, methods: null, attempts: [], done: false };
  var attempts = report.attempts;

  try {
    var raw = typeof pdfmake !== "undefined" ? pdfmake : null;
    report.raw = describe(raw);

    var lib = raw && raw.default ? raw.default : raw;
    report.lib = describe(lib);
    report.methods = ["createPdf", "addFonts", "setFonts", "setLocalAccessPolicy", "vfs"]
      .map(function (name) { return name + "=" + (lib ? typeof lib[name] : "нет"); })
      .join(" ");

    if (!lib || typeof lib.createPdf !== "function") {
      throw new Error("createPdf не найден ни в переменной, ни в default");
    }

    // 1. Вдруг шрифт по умолчанию уже подключен.
    var base64 = await tryRender(lib, null, "без шрифтов", attempts);

    // 2. Серверная сборка ждет пути к TTF внутри пакета.
    if (!base64) {
      var dir = "node_modules/pdfmake/fonts/Roboto/";
      base64 = await tryRender(lib, {
        Roboto: {
          normal: dir + "Roboto-Regular.ttf",
          bold: dir + "Roboto-Medium.ttf",
          italics: dir + "Roboto-Italic.ttf",
          bolditalics: dir + "Roboto-MediumItalic.ttf"
        }
      }, "пути в node_modules", attempts);
    }

    // 3. То же, но абсолютным путем от корня функции.
    if (!base64) {
      var abs = "/home/app/node_modules/pdfmake/fonts/Roboto/";
      base64 = await tryRender(lib, {
        Roboto: {
          normal: abs + "Roboto-Regular.ttf",
          bold: abs + "Roboto-Medium.ttf",
          italics: abs + "Roboto-Italic.ttf",
          bolditalics: abs + "Roboto-MediumItalic.ttf"
        }
      }, "абсолютный путь", attempts);
    }

    report.done = !!base64;
  } catch (error) {
    attempts.push("fatal: " + (error && error.message ? error.message : String(error)).slice(0, 160));
  }

  await Reactions.sendText({ text: "```json\n" + JSON.stringify(report) + "\n```" });
  await Log.info({ message: "Спайк pdfmake 2", data: report });
  return report;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { probe: probe, describe: describe };
} else {
  return probe();
}
