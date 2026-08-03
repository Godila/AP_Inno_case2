const LABELS = {
  type: "Тип объекта",
  area: "Площадь, м2",
  wall_material: "Материал стен",
  roof_material: "Материал крыши",
  year: "Год постройки",
  floors: "Этажность",
  address: "Адрес",
  owner: "Собственник"
};

const messagesEl = document.getElementById("messages");
const fieldsEl = document.getElementById("fields");
const priceEl = document.getElementById("price");
const statusEl = document.getElementById("status");
const recordBtn = document.getElementById("record");
const fileInput = document.getElementById("file");
const textForm = document.getElementById("text-form");
const textInput = document.getElementById("text");
const resetBtn = document.getElementById("reset");
const policyEl = document.getElementById("policy");

let clientId = localStorage.getItem("clientId");
if (!clientId) {
  clientId = "demo-" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("clientId", clientId);
}

let recorder = null;
let chunks = [];
let previousCard = {};
let policyUrl = null;
// Автор держится между ходами: андеррайтер может ответить и без вызова инструмента,
// тогда нового этапа в ходе не будет.
let currentAuthor = { role: "assistant", name: "Помощник" };

function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, text, author) {
  const node = document.createElement("div");
  node.className = "msg " + role;
  if (author) {
    const label = document.createElement("div");
    label.className = "author";
    label.textContent = author;
    node.appendChild(label);
  }
  const body = document.createElement("div");
  body.textContent = text;
  node.appendChild(body);
  messagesEl.appendChild(node);
  scrollDown();
}

// Пока идет ход, в ленте висит пузырь с точками: сорок секунд тишины выглядят
// как зависшая страница.
function showPending(author) {
  hidePending();
  const node = document.createElement("div");
  node.className = "msg bot pending " + (author === "Андеррайтер" ? "underwriter" : "assistant");
  node.id = "pending";
  const label = document.createElement("div");
  label.className = "author";
  label.textContent = author;
  node.appendChild(label);
  const dots = document.createElement("div");
  dots.className = "dots";
  for (let i = 0; i < 3; i++) {
    dots.appendChild(document.createElement("i"));
  }
  node.appendChild(dots);
  messagesEl.appendChild(node);
  scrollDown();
}

function hidePending() {
  const node = document.getElementById("pending");
  if (node) {
    node.remove();
  }
}

function renderCard(card) {
  fieldsEl.innerHTML = "";
  Object.keys(LABELS).forEach(function (field) {
    const dt = document.createElement("dt");
    dt.textContent = LABELS[field];
    const dd = document.createElement("dd");
    const value = card ? card[field] : null;
    if (value === null || value === undefined || value === "") {
      dd.textContent = "—";
      dd.className = "empty";
    } else {
      dd.textContent = String(value);
      dd.className = previousCard[field] !== value ? "filled" : "";
    }
    fieldsEl.appendChild(dt);
    fieldsEl.appendChild(dd);
  });
  previousCard = card ? Object.assign({}, card) : {};
}

function renderPrice(price) {
  if (!price || price.value === null || price.value === undefined) {
    priceEl.textContent = "Стоимость: не рассчитана";
    return;
  }
  const amount = price.value.toLocaleString("ru-RU");
  priceEl.textContent = "Стоимость: " + (price.preliminary ? "от " : "") + amount + " руб";
}

// Chat API возвращает ответы в data.replies: [{type: "text", text: "..."}].
// Поле data.answer при этом пустое, поэтому оно только резервный источник.
function replyTexts(response) {
  const data = response && response.data ? response.data : {};
  const replies = Array.isArray(data.replies) ? data.replies : [];
  const texts = replies
    .filter(function (reply) { return reply && reply.type === "text" && typeof reply.text === "string"; })
    .map(function (reply) { return reply.text; });
  if (!texts.length && typeof data.answer === "string" && data.answer) {
    texts.push(data.answer);
  }
  return texts;
}

function parseBlock(text) {
  const match = text.match(/```json\s*([\s\S]+?)```/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    return null;
  }
}

// Автор реплики определяется по этапу из последнего JSON-блока: инструмент шлет свой
// блок перед тем, как агент заговорит, поэтому порядок реплик в ходе всегда такой.
const AUTHORS = {
  collect: { role: "assistant", name: "Помощник" },
  risk: { role: "underwriter", name: "Андеррайтер" },
  issued: { role: "underwriter", name: "Андеррайтер" }
};

// Агент иногда отвечает с markdown-разметкой, а сообщения выводятся как обычный текст,
// поэтому звездочки убираем здесь: это надежнее, чем просить модель их не ставить.
function cleanText(text) {
  return text
    .replace(/```json[\s\S]+?```/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .trim();
}

// Вызов MCP-поиска сам по себе на страницу ничего не шлет, поэтому андеррайтер
// объявляет запрос отдельной строкой, а страница выносит ее в заметный след.
const SEARCH_LINE = /^\s*ПОИСК:\s*(.+?)\s*$/;

function splitSearch(text) {
  const queries = [];
  const rest = text.split("\n").filter(function (line) {
    const match = line.match(SEARCH_LINE);
    if (match) {
      queries.push(match[1]);
      return false;
    }
    return true;
  });
  return { queries: queries, text: rest.join("\n").trim() };
}

function addSearch(query) {
  const node = document.createElement("div");
  node.className = "msg search";
  const label = document.createElement("div");
  label.className = "author";
  label.textContent = "Открытые источники · MCP";
  const body = document.createElement("div");
  body.textContent = "Ищу: " + query;
  node.appendChild(label);
  node.appendChild(body);
  messagesEl.appendChild(node);
  scrollDown();
}

function applyPayload(payload) {
  if (payload.card) {
    renderCard(payload.card);
    renderPrice(payload.price);
  }
  if (payload.policy && payload.pdfBase64) {
    renderPolicy(payload.policy, payload.pdfBase64);
  }
}

// Реплики не склеиваем: в одном ходе их может быть несколько, в том числе от разных
// агентов, и каждая должна быть отдельным сообщением со своим автором.
function renderTurn(response) {
  replyTexts(response).forEach(function (raw) {
    const payload = parseBlock(raw);
    if (payload) {
      currentAuthor = AUTHORS[payload.stage] || currentAuthor;
      applyPayload(payload);
    }
    const parts = splitSearch(cleanText(raw));
    parts.queries.forEach(addSearch);
    if (parts.text) {
      addMessage("bot " + currentAuthor.role, parts.text, currentAuthor.name);
    }
  });
}

function clearPolicy() {
  if (policyUrl) {
    URL.revokeObjectURL(policyUrl);
    policyUrl = null;
  }
  policyEl.innerHTML = "";
}

// PDF показываем из Blob, а не из data-URI: браузеры не дают открывать
// data:application/pdf ни во фрейме, ни по ссылке.
function renderPolicy(policy, base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  if (policyUrl) {
    URL.revokeObjectURL(policyUrl);
  }
  policyUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));

  policyEl.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = "Полис " + policy.number;
  const frame = document.createElement("iframe");
  frame.className = "preview";
  frame.src = policyUrl;
  frame.title = "Полис " + policy.number;
  const link = document.createElement("a");
  link.className = "download";
  link.href = policyUrl;
  link.download = policy.number + ".pdf";
  link.textContent = "Скачать PDF";
  policyEl.appendChild(title);
  policyEl.appendChild(frame);
  policyEl.appendChild(link);
}

async function send(body) {
  statusEl.textContent = "Обрабатываю…";
  recordBtn.disabled = true;
  showPending(currentAuthor.name);
  try {
    const response = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ clientId: clientId }, body))
    });
    if (!response.ok) {
      const detail = await response.json().catch(function () { return {}; });
      addMessage("bot", "Ошибка: " + (detail.error || response.status) + ". Попробуйте ещё раз.");
      return;
    }
    const result = await response.json();
    renderTurn(result);
  } catch (error) {
    addMessage("bot", "Сеть недоступна: " + error.message);
  } finally {
    hidePending();
    statusEl.textContent = "";
    recordBtn.disabled = false;
  }
}

// Распознавание делает прокси при загрузке записи, в диалог уходит уже текст.
async function uploadAndSend(blob, filename) {
  statusEl.textContent = "Распознаю запись…";
  recordBtn.disabled = true;
  const form = new FormData();
  form.append("file", blob, filename);
  let result;
  try {
    const response = await fetch("/api/audio", { method: "POST", body: form });
    result = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      addMessage("bot", "Не удалось распознать запись: " + (result.error || response.status));
      return;
    }
  } catch (error) {
    addMessage("bot", "Сеть недоступна: " + error.message);
    return;
  } finally {
    statusEl.textContent = "";
    recordBtn.disabled = false;
  }
  if (!result.text) {
    addMessage("bot", "Не расслышал, повторите пожалуйста.");
    return;
  }
  addMessage("agent", result.text);
  await send({ text: result.text });
}

recordBtn.addEventListener("click", async function () {
  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recorder = new MediaRecorder(stream);
  chunks = [];
  recorder.ondataavailable = function (event) { chunks.push(event.data); };
  recorder.onstop = function () {
    stream.getTracks().forEach(function (track) { track.stop(); });
    recordBtn.classList.remove("recording");
    recordBtn.textContent = "Записать голос";
    uploadAndSend(new Blob(chunks, { type: recorder.mimeType }), "voice.webm");
  };
  recorder.start();
  recordBtn.classList.add("recording");
  recordBtn.textContent = "Остановить";
});

fileInput.addEventListener("change", function () {
  const file = fileInput.files[0];
  if (file) {
    uploadAndSend(file, file.name);
    fileInput.value = "";
  }
});

textForm.addEventListener("submit", function (event) {
  event.preventDefault();
  const value = textInput.value.trim();
  if (!value) {
    return;
  }
  addMessage("agent", value);
  textInput.value = "";
  send({ text: value });
});

// Сброс локальный и мгновенный. Карточка живет в SessionDb платформы, привязанной
// к клиенту, поэтому новый clientId и есть новый прогон. Событие в платформу не шлем:
// триггера на него нет, агент принимает его за реплику и отвечает вопросом.
resetBtn.addEventListener("click", function () {
  clientId = "demo-" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("clientId", clientId);
  messagesEl.innerHTML = "";
  previousCard = {};
  currentAuthor = AUTHORS.collect;
  clearPolicy();
  renderCard(null);
  renderPrice(null);
  addMessage("bot assistant", "Опишите объект страхования.", "Помощник");
});

renderCard(null);
renderPrice(null);
addMessage("bot assistant", "Опишите объект страхования.", "Помощник");
