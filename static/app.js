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

let clientId = localStorage.getItem("clientId");
if (!clientId) {
  clientId = "demo-" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("clientId", clientId);
}

let recorder = null;
let chunks = [];
let previousCard = {};

function addMessage(role, text) {
  const node = document.createElement("div");
  node.className = "msg " + role;
  node.textContent = text;
  messagesEl.appendChild(node);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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

function extractPayload(response) {
  const texts = replyTexts(response);
  for (const text of texts) {
    const match = text.match(/```json\s*([\s\S]+?)```/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (error) {
        return null;
      }
    }
  }
  return null;
}

function botText(response, payload) {
  if (payload && payload.question) {
    return payload.question;
  }
  return replyTexts(response)
    .join("\n")
    .replace(/```json[\s\S]+?```/g, "")
    .trim();
}

async function send(body) {
  statusEl.textContent = "Обрабатываю…";
  recordBtn.disabled = true;
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
    const payload = extractPayload(result);
    const text = botText(result, payload);
    if (text) {
      addMessage("bot", text);
    }
    if (payload) {
      renderCard(payload.card);
      renderPrice(payload.price);
    }
  } catch (error) {
    addMessage("bot", "Сеть недоступна: " + error.message);
  } finally {
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

resetBtn.addEventListener("click", async function () {
  await fetch("/api/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: clientId })
  });
  // Карточка живет в SessionDb платформы, поэтому новый прогон начинаем с новой сессии.
  clientId = "demo-" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("clientId", clientId);
  messagesEl.innerHTML = "";
  previousCard = {};
  renderCard(null);
  renderPrice(null);
  addMessage("bot", "Опишите объект страхования.");
});

renderCard(null);
renderPrice(null);
addMessage("bot", "Опишите объект страхования.");
