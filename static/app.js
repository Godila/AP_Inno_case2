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
const assessmentEl = document.getElementById("assessment");
const archiveEl = document.getElementById("archive");

// Новый идентификатор на каждую загрузку страницы. Раньше он хранился в localStorage,
// и получалось, что лента сообщений после F5 пустая, а карточка в SessionDb платформы
// живая: в свежий на вид разговор подмешивались адрес и собственник из прошлого прогона.
// Переписка все равно не переживает перезагрузку, так что и сессии незачем.
let clientId = "demo-" + Math.random().toString(36).slice(2, 10);

let recorder = null;
let chunks = [];
let previousCard = {};
let lastPolicy = null;
let handoffNudged = false;
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
  if (payload.stage === "risk") {
    renderAssessment(payload);
  }
  if (payload.policy) {
    lastPolicy = payload.policy;
    renderPolicy();
  }
}

// Реплики не склеиваем: в одном ходе их может быть несколько, в том числе от разных
// агентов, и каждая должна быть отдельным сообщением со своим автором.
function renderTurn(response) {
  let handoff = false;
  let spoken = 0;
  replyTexts(response).forEach(function (raw) {
    const payload = parseBlock(raw);
    if (payload) {
      currentAuthor = AUTHORS[payload.stage] || currentAuthor;
      if (payload.stage === "collect" && payload.isComplete) {
        handoff = true;
      }
      applyPayload(payload);
    }
    const parts = splitSearch(cleanText(raw));
    parts.queries.forEach(addSearch);
    if (parts.text) {
      addMessage("bot " + currentAuthor.role, parts.text, currentAuthor.name);
      if (handoff) {
        spoken += 1;
        // Итог по карточке - последняя реплика консультанта. Все, что после нее,
        // говорит уже андеррайтер, даже если он не успел вызвать инструмент.
        if (spoken === 1) {
          currentAuthor = AUTHORS.risk;
        }
      }
    }
  });
  return { handoff: handoff, underwriterSpoke: spoken > 1 };
}

function clearPolicy() {
  lastPolicy = null;
  policyEl.innerHTML = "";
}

const RISK_LABELS = {
  heating: "Отопление",
  security: "Охрана",
  occupancy: "Проживание"
};

const VERDICTS = {
  accepted: { text: "Заявка принята", cls: "ok" },
  escalated: { text: "На ручное рассмотрение", cls: "warn" },
  declined: { text: "Отказ в страховании", cls: "bad" },
  unavailable: { text: "Проверка недоступна", cls: "bad" },
  incomplete: { text: "Собираем риск-профиль", cls: "wait" }
};

function money(value) {
  return typeof value === "number" ? value.toLocaleString("ru-RU") + " руб" : "—";
}

// Коэффициент показываем процентом: "печное отопление +15%" читается с экрана,
// а "k 1.15" требует объяснений.
function percent(k) {
  const shift = Math.round((k - 1) * 100);
  return (shift > 0 ? "+" : "") + shift + "%";
}

function addRows(parent, rows) {
  const list = document.createElement("dl");
  rows.forEach(function (row) {
    const dt = document.createElement("dt");
    dt.textContent = row[0];
    const dd = document.createElement("dd");
    dd.textContent = row[1];
    list.appendChild(dt);
    list.appendChild(dd);
  });
  parent.appendChild(list);
}

function renderAssessment(payload) {
  assessmentEl.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = "Оценка риска";
  assessmentEl.appendChild(title);

  const risk = payload.risk || {};
  addRows(assessmentEl, Object.keys(RISK_LABELS).map(function (field) {
    return [RISK_LABELS[field], risk[field] ? String(risk[field]) : "—"];
  }));

  const verdict = VERDICTS[payload.decision] || VERDICTS.incomplete;
  const badge = document.createElement("div");
  badge.className = "verdict " + verdict.cls;
  badge.textContent = verdict.text;
  assessmentEl.appendChild(badge);

  if (payload.reasons && payload.reasons.length) {
    const list = document.createElement("ul");
    list.className = "reasons";
    payload.reasons.forEach(function (item) {
      const node = document.createElement("li");
      node.textContent = item.reason;
      if (typeof item.k === "number") {
        const tag = document.createElement("span");
        tag.className = item.k > 1 ? "up" : "down";
        tag.textContent = percent(item.k);
        node.appendChild(tag);
      }
      list.appendChild(node);
    });
    assessmentEl.appendChild(list);
  }

  if (payload.decision === "accepted") {
    addRows(assessmentEl, [
      ["Страховая сумма", money(payload.sumInsured)],
      ["Франшиза", money(payload.franchise)],
      ["Премия с учётом риска", money(payload.price)]
    ]);
  }
}

function clearAssessment() {
  assessmentEl.innerHTML = "";
}

// Реквизиты полиса страница забирает у прокси, а не из диалога: реплики функции
// выпуска до канала не доезжают ни целиком, ни по частям. Функция кладет их туда же,
// куда и бланк.
async function fetchPolicy() {
  try {
    const response = await fetch("/api/policy/latest?clientId=" + encodeURIComponent(clientId));
    if (!response.ok) {
      return;
    }
    const found = (await response.json()).policy;
    if (found && (!lastPolicy || lastPolicy.number !== found.number)) {
      lastPolicy = found;
      renderPolicy();
    }
  } catch (error) {
    // Полис не главное в ходе: молчим и пробуем на следующем.
  }
}

// Бланк лежит на прокси и приходит ссылкой: в песочнице платформы нет объектного
// хранилища, а реплика с base64 до канала не доезжает.
function renderPolicy() {
  if (!lastPolicy) {
    return;
  }
  policyEl.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = "Полис " + lastPolicy.number;
  policyEl.appendChild(title);

  const term = document.createElement("div");
  term.className = "term";
  term.textContent = "с " + lastPolicy.issuedAt + " по " + lastPolicy.expiresAt;
  policyEl.appendChild(term);

  if (!lastPolicy.pdfUrl) {
    const note = document.createElement("div");
    note.className = "term";
    note.textContent = "Бланк не сформирован.";
    policyEl.appendChild(note);
    return;
  }

  policyEl.appendChild(downloadLink(lastPolicy, "Скачать PDF"));
}

function downloadLink(policy, text) {
  const link = document.createElement("a");
  link.className = "download";
  link.href = policy.pdfUrl;
  link.download = policy.number + ".pdf";
  link.textContent = text;
  return link;
}

// Реестр общий, а не по сессии: "Начать заново" выдает новый идентификатор клиента,
// и архив по сессии всегда содержал бы одну запись.
async function fetchArchive() {
  try {
    const response = await fetch("/api/policy/archive?limit=20");
    if (!response.ok) {
      return;
    }
    renderArchive((await response.json()).policies || []);
  } catch (error) {
    // Реестр не главное на экране: молчим и пробуем на следующем ходе.
  }
}

function renderArchive(policies) {
  archiveEl.innerHTML = "";
  if (!policies.length) {
    return;
  }
  const title = document.createElement("h2");
  title.textContent = "Реестр полисов";
  archiveEl.appendChild(title);

  const list = document.createElement("ul");
  list.className = "archive-list";
  policies.forEach(function (policy) {
    const item = document.createElement("li");
    const head = document.createElement("div");
    head.className = "archive-head";
    const number = document.createElement("span");
    number.className = "archive-number";
    number.textContent = policy.number;
    const sum = document.createElement("span");
    sum.textContent = money(policy.price);
    head.appendChild(number);
    head.appendChild(sum);

    const meta = document.createElement("div");
    meta.className = "archive-meta";
    meta.textContent = (policy.card && policy.card.address ? policy.card.address + ", " : "") +
      "от " + policy.issuedAt;

    item.appendChild(head);
    item.appendChild(meta);
    if (policy.pdfUrl) {
      item.appendChild(downloadLink(policy, "PDF"));
    }
    list.appendChild(item);
  });
  archiveEl.appendChild(list);
}

async function send(body) {
  let turn = null;
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
    turn = renderTurn(result);
    await fetchPolicy();
    await fetchArchive();
  } catch (error) {
    addMessage("bot", "Сеть недоступна: " + error.message);
  } finally {
    hidePending();
    statusEl.textContent = "";
    recordBtn.disabled = false;
  }

  // Платформа передает управление андеррайтеру по достижении цели консультанта,
  // но заговорить в том же ходе он успевает не всегда. Если после итога по карточке
  // никто не ответил, подталкиваем ход сами - иначе агенту пришлось бы писать
  // "жду", чтобы разговор поехал дальше.
  if (turn && turn.handoff && !turn.underwriterSpoke && !handoffNudged) {
    handoffNudged = true;
    await send({ text: "продолжаем" });
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
  messagesEl.innerHTML = "";
  previousCard = {};
  currentAuthor = AUTHORS.collect;
  handoffNudged = false;
  clearAssessment();
  clearPolicy();
  renderCard(null);
  renderPrice(null);
  addMessage("bot assistant", "Опишите объект страхования.", "Помощник");
});

renderCard(null);
renderPrice(null);
addMessage("bot assistant", "Опишите объект страхования.", "Помощник");
fetchArchive();
