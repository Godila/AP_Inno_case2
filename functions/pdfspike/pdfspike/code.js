// Временный узел-спайк. Отвечает на четыре вопроса и удаляется:
// 1. Как отдается npm-пакет: готовой переменной по code-name или через require.
// 2. Становятся ли встроенные функции асинхронными при подключенных зависимостях.
//    Это важнее PDF: если да, saveCard в коллекции my надо переписать на await.
// 3. Доступны ли подпути пакета (pdfmake/fonts/Roboto).
// 4. Укладывается ли рендер в лимит песочницы (локально на Node 24 - 64 мс).
//
// Каждый шаг подписан в report.step, поэтому падение сразу показывает место.
// Все вызовы обернуты в await: await на обычном значении безвреден, так что код
// работает и в синхронном, и в асинхронном режиме.

async function probe() {
  var report = {
    spike: "pdfmake",
    step: "start",
    libSource: null,
    fontsSource: null,
    asyncBuiltins: null,
    ms: null,
    pdfKb: null,
    base64Kb: null,
    signature: null,
    error: null
  };

  try {
    report.step = "builtins";
    var probeCall = SessionDb.get({ documentKey: "card" });
    report.asyncBuiltins = !!(probeCall && typeof probeCall.then === "function");
    await probeCall;

    report.step = "lib";
    var lib = null;
    if (typeof pdfmake !== "undefined" && pdfmake) {
      lib = pdfmake;
      report.libSource = "global";
    } else if (typeof require === "function") {
      lib = require("pdfmake");
      report.libSource = "require";
    }
    if (!lib) {
      throw new Error("пакет недоступен ни переменной, ни через require");
    }

    report.step = "fonts";
    var fonts = null;
    if (typeof require === "function") {
      try {
        fonts = require("pdfmake/fonts/Roboto");
        report.fontsSource = "subpath";
      } catch (fontError) {
        report.fontsSource = "subpath failed: " + fontError.message;
      }
    }
    if (fonts) {
      await lib.addFonts(fonts);
    }

    report.step = "render";
    var started = Date.now();
    var document = {
      defaultStyle: { font: "Roboto", fontSize: 11 },
      content: [
        { text: "Проверка кириллицы", fontSize: 18, bold: true },
        { text: "дача, бревно, металлочерепица, Иванов Пётр Сергеевич" }
      ]
    };
    var buffer = await lib.createPdf(document).getBuffer();
    report.ms = Date.now() - started;

    report.step = "encode";
    var base64 = typeof buffer.toString === "function"
      ? buffer.toString("base64")
      : Buffer.from(buffer).toString("base64");
    report.pdfKb = Math.round(base64.length * 0.75 / 102.4) / 10;
    report.base64Kb = Math.round(base64.length / 102.4) / 10;
    report.signature = base64.slice(0, 8);
    report.step = "ok";
  } catch (error) {
    report.error = error && error.message ? error.message : String(error);
  }

  await Reactions.sendText({ text: "```json\n" + JSON.stringify(report) + "\n```" });
  await Log.info({ message: "Спайк pdfmake", data: report });
  return report;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { probe: probe };
} else {
  return probe();
}
