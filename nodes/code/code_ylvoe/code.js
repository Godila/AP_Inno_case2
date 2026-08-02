// Диагностика: что приходит из Chat API и как ответ выглядит на стороне клиента.
var raw = Context.getRawRequest();
var content = Context.getMessageContent();

Log.info({ text: "SPIKE raw: " + JSON.stringify(raw) });
Log.info({ text: "SPIKE content: " + JSON.stringify(content) });

var data = raw && raw.data ? raw.data : null;
var files = content && content.files ? content.files : null;

var payload = {
  card: {
    type: "дача",
    area: 120,
    wall_material: "бревно",
    roof_material: null,
    year: null,
    floors: 2,
    address: null,
    owner: null
  },
  missing: ["year", "roof_material"],
  price: { value: null, preliminary: true, breakdown: null },
  question: "Какой год постройки?",
  isComplete: false
};

Reactions.sendText({
  text: "data=" + JSON.stringify(data) +
    " files=" + JSON.stringify(files) +
    "\n```json\n" + JSON.stringify(payload) + "\n```"
});
