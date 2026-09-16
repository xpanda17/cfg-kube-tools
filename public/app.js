'use strict';

const CATEGORY_ORDER = ['app', 'canary', 'sut', 'lb', 'worker', 'cronjob'];

const CATEGORY_LABELS = {
  app: 'Apps',
  canary: 'Canary',
  sut: 'SUT',
  lb: 'Load balancers',
  worker: 'Workers',
  cronjob: 'CronJobs',
};

// Restart rolls a Deployment, so it only applies where one exists.
// Restart and scale act on a Deployment, so they apply to every category that
// has one. CronJob pods are owned by a Job, and load balancers are managed
// alongside their app, so both are left out.
const RESTARTABLE = ['app', 'canary', 'sut', 'worker'];

// Port forwarding needs a container port, which only the traffic-serving
// categories declare.
const FORWARDABLE = ['app', 'canary', 'sut'];

const el = {
  service: document.getElementById('service'),
  env: document.getElementById('env'),
  filter: document.getElementById('filter'),
  refresh: document.getElementById('refresh'),
  banner: document.getElementById('banner'),
  btnSpinner: document.getElementById('btn-spinner'),
  headSpinner: document.getElementById('head-spinner'),
  groups: document.getElementById('groups'),
  subtabs: document.getElementById('subtabs'),
  meta: document.getElementById('meta'),
  confirm: document.getElementById('confirm'),
  confirmTitle: document.getElementById('confirm-title'),
  confirmBody: document.getElementById('confirm-body'),
  confirmCmd: document.getElementById('confirm-cmd'),
  confirmOk: document.getElementById('confirm-ok'),
  confirmInput: document.getElementById('confirm-input'),
  confirmInputWrap: document.getElementById('confirm-input-wrap'),
  confirmCancel: document.getElementById('confirm-cancel'),
  status: document.getElementById('status'),
  target: document.getElementById('target'),
};

let services = [];
let pods = [];
let forwards = [];
let inFlight = null;
let autoscalers = {};
let activeCategory = 'app';
const subtabEls = new Map();

/* ---------- helpers ---------- */

function setLoading(on) {
  el.headSpinner.classList.toggle('hidden', !on);
  el.refresh.disabled = on;
  el.btnSpinner.classList.toggle('hidden', !on);
  el.groups.classList.toggle('busy', on);
}

function showBanner(message, detail, tone) {
  el.banner.classList.remove('hidden');
  el.banner.classList.toggle('ok', tone === 'ok');
  el.banner.innerHTML = '';

  const text = document.createElement('div');
  text.textContent = message;
  el.banner.appendChild(text);

  if (detail) {
    const pre = document.createElement('pre');
    pre.textContent = detail;
    el.banner.appendChild(pre);
  }
}

function hideBanner() {
  el.banner.classList.add('hidden');
}

function showPlaceholder(message) {
  el.groups.innerHTML = '';

  const div = document.createElement('div');
  div.className = 'placeholder';
  div.textContent = message;
  el.groups.appendChild(div);
}

function pill(text, tone, flat) {
  const span = document.createElement('span');

  span.className = `pill ${tone}${flat ? ' flat' : ''}`;
  span.textContent = text;

  return span;
}

/**
 * Shows a modal and resolves to whether it was confirmed. Cancel is focused on
 * open and Escape closes, so the destructive action is never the default.
 *
 * @param {Object} options
 * @returns {Promise<boolean>}
 */
function confirmAction(options) {
  const wantsInput = Object.prototype.hasOwnProperty.call(options, 'inputValue');

  el.confirmTitle.textContent = options.title;
  el.confirmBody.textContent = options.body;
  el.confirmCmd.textContent = options.command;
  el.confirmOk.textContent = options.confirmLabel;
  el.confirmOk.classList.toggle('danger', options.tone !== 'safe');
  el.confirmInputWrap.classList.toggle('hidden', !wantsInput);

  if (wantsInput) {
    el.confirmInput.value = String(options.inputValue);
    el.confirmInput.oninput = () => {
      const value = Number(el.confirmInput.value);
      const valid = Number.isInteger(value) && value >= 0 && value <= 50;

      el.confirmOk.disabled = !valid;

      if (valid && options.onInput) {
        el.confirmCmd.textContent = options.onInput(value);
      }
    };
  } else {
    el.confirmOk.disabled = false;
  }

  el.confirm.showModal();

  // The input is the point of the dialog when there is one; otherwise keep
  // focus off the destructive button.
  if (wantsInput) {
    el.confirmInput.focus();
    el.confirmInput.select();
  } else {
    el.confirmCancel.focus();
  }

  return new Promise((resolve) => {
    el.confirm.addEventListener(
      'close',
      () => {
        if (el.confirm.returnValue !== 'ok') {
          return resolve(null);
        }

        resolve(wantsInput ? { value: Number(el.confirmInput.value) } : { value: true });
      },
      { once: true }
    );
  });
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json();

  if (!res.ok) {
    throw new Error((payload.error && payload.error.message) || 'Request failed');
  }

  return payload;
}

function findForward(pod, port) {
  return forwards.find((item) => item.pod === pod && item.port === port);
}

async function loadForwards() {
  try {
    const res = await fetch('/api/portforward');
    const body = await res.json();

    forwards = body.sessions.filter((item) => item.status === 'running');
  } catch (err) {
    forwards = [];
  }
}

/* ---------- actions ---------- */

async function restartDeployment(pod) {
  const count = pods.filter((item) => item.deployment === pod.deployment).length;
  const ok = await confirmAction({
    title: `Restart ${pod.deployment}?`,
    body:
      `This rolls all ${count} pod${count === 1 ? '' : 's'} of the deployment, ` +
      `not just ${pod.name}. Pods are replaced one at a time, in ` +
      `${el.target.textContent.split(' · ')[0]}.`,
    command: `kubectl rollout restart deployment/${pod.deployment}`,
    confirmLabel: 'Restart deployment',
  });

  if (!ok) {
    return;
  }

  try {
    const body = await post('/api/restart', {
      service: el.service.value,
      env: el.env.value,
      deployment: pod.deployment,
    });

    showBanner(body.message, null, 'ok');
    await loadPods();
  } catch (err) {
    showBanner(`Restart failed: ${err.message}`);
  }
}

async function scaleDeployment(pod) {
  const current = pods.filter((item) => item.deployment === pod.deployment).length;
  const autoscaler = autoscalers[pod.deployment];
  const scaleCmd = (value) =>
    `kubectl scale --replicas=${value} deployment/${pod.deployment}`;
  const command = (value) =>
    autoscaler
      ? `kubectl patch scaledobject ${autoscaler.name} --type=merge \\\n` +
        `  -p '{"spec":{"minReplicaCount":${value},"maxReplicaCount":${value},…}}'\n` +
        scaleCmd(value)
      : scaleCmd(value);

  const body = autoscaler
    ? `${pod.deployment} is autoscaled by ${autoscaler.name} ` +
      `(min ${autoscaler.min}, max ${autoscaler.max}). KEDA would undo a plain scale, ` +
      `so the ScaledObject is pinned to the new count first — its min, max and cron ` +
      `desiredReplicas are all overwritten.`
    : `${pod.deployment} has no autoscaler, so the replica count is set directly.`;

  const answer = await confirmAction({
    title: `Scale ${pod.deployment}`,
    body: `Currently running ${current} pod${current === 1 ? '' : 's'}. ${body}`,
    command: command(current),
    confirmLabel: 'Apply',
    inputValue: current,
    onInput: command,
  });

  if (!answer) {
    return;
  }

  try {
    const result = await post('/api/scale', {
      service: el.service.value,
      env: el.env.value,
      deployment: pod.deployment,
      replicas: answer.value,
    });

    showBanner(result.steps.join(' · '), null, 'ok');
    await loadPods();
  } catch (err) {
    showBanner(`Scale failed: ${err.message}`);
  }
}

async function toggleForward(pod, port) {
  const active = findForward(pod.name, port);

  try {
    if (active) {
      await post('/api/portforward/stop', { id: active.id });
    } else {
      await post('/api/portforward', {
        service: el.service.value,
        env: el.env.value,
        pod: pod.name,
        port,
      });
    }

    await loadForwards();
    render();
  } catch (err) {
    showBanner(`Port forward failed: ${err.message}`);
  }
}

/* ---------- rendering ---------- */

/**
 * Closes any open row menu. A single menu is open at a time, positioned with
 * fixed coordinates so the table's own overflow cannot clip it.
 */
let openMenu = null;

function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

document.addEventListener('click', closeMenu);
window.addEventListener('scroll', closeMenu, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeMenu();
  }
});

/**
 * Builds the row menu. Actions live here rather than as inline buttons so the
 * table stays readable and each action can carry a full, unambiguous label.
 *
 * @param {Object} pod
 * @param {string} category
 * @param {DOMRect} anchor
 */
function openRowMenu(pod, category, anchor) {
  closeMenu();

  const menu = document.createElement('div');
  menu.className = 'menu';

  const add = (label, hint, handler, tone) => {
    const item = document.createElement('button');

    item.className = `menu-item${tone ? ` ${tone}` : ''}`;

    const main = document.createElement('span');
    main.textContent = label;
    item.appendChild(main);

    if (hint) {
      const sub = document.createElement('span');
      sub.className = 'menu-hint';
      sub.textContent = hint;
      item.appendChild(sub);
    }

    item.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenu();
      handler();
    });

    menu.appendChild(item);
  };

  if (RESTARTABLE.includes(category) && pod.deployment) {
    const siblings = pods.filter((item) => item.deployment === pod.deployment).length;

    add(
      'Restart deployment',
      `rolls all ${siblings} pod${siblings === 1 ? '' : 's'} of ${pod.deployment}`,
      () => restartDeployment(pod),
      'danger'
    );
  }

  if (RESTARTABLE.includes(category) && pod.deployment) {
    const autoscaler = autoscalers[pod.deployment];

    add(
      'Scale…',
      autoscaler
        ? `autoscaled: min ${autoscaler.min}, max ${autoscaler.max}`
        : 'set the replica count directly',
      () => scaleDeployment(pod)
    );
  }

  if (FORWARDABLE.includes(category)) {
    pod.ports.forEach((port) => {
      const active = findForward(pod.name, port);

      add(
        active ? `Stop port-forward :${port}` : `Port-forward :${port}`,
        active ? `listening on 127.0.0.1:${port}` : `${port} → 127.0.0.1:${port}`,
        () => toggleForward(pod, port)
      );
    });
  }

  if (!menu.childElementCount) {
    return;
  }

  menu.style.top = `${Math.round(anchor.bottom + 4)}px`;
  menu.style.left = `${Math.round(anchor.right - 240)}px`;
  menu.addEventListener('click', (event) => event.stopPropagation());

  document.body.appendChild(menu);
  openMenu = menu;
}

function renderActionsCell(pod, category) {
  const td = document.createElement('td');
  td.className = 'actions-cell';

  const active = pod.ports
    .map((port) => findForward(pod.name, port))
    .filter(Boolean);

  active.forEach((session) => {
    const link = document.createElement('a');

    link.className = 'fwd-chip';
    link.href = session.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = `:${session.port} \u2197`;
    link.title = `Forwarding to ${session.url}`;
    link.addEventListener('click', (event) => event.stopPropagation());
    td.appendChild(link);
  });

  const trigger = document.createElement('button');

  trigger.className = 'row-menu';
  trigger.textContent = '\u22ef';
  trigger.setAttribute('aria-label', 'Actions');
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();

    if (openMenu) {
      closeMenu();
      return;
    }

    openRowMenu(pod, category, trigger.getBoundingClientRect());
  });

  td.appendChild(trigger);

  return td;
}

/**
 * Builds the table for a category. Values come from the cluster, so every cell
 * is set with textContent rather than interpolated as markup.
 *
 * @param {string} category
 * @param {Array<Object>} rows
 * @returns {HTMLElement}
 */
function renderTable(category, rows) {
  const card = document.createElement('div');
  card.className = 'table-wrap';

  const table = document.createElement('table');
  table.className = 'pods';

  const columns = [
    ['Name', 'name'],
    ['Ready', 'ready'],
    ['Status', ''],
    ['Restarts', 'num'],
    ['Age', 'num'],
    ['', 'actions-head'],
  ];

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');

  columns.forEach(([label, cls]) => {
    const th = document.createElement('th');

    th.textContent = label;
    th.className = cls;
    headRow.appendChild(th);
  });

  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  rows.forEach((pod) => {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.className = 'name';
    name.textContent = pod.name;
    name.title = pod.version ? `version ${pod.version}` : pod.name;

    const ready = document.createElement('td');
    ready.className = 'ready';
    ready.textContent = pod.ready;

    const status = document.createElement('td');
    status.appendChild(
      pill(pod.status, pod.healthy ? 'ok' : /BackOff|Error|Failed/.test(pod.status) ? 'bad' : 'warn')
    );

    const restarts = document.createElement('td');
    restarts.className = pod.restarts ? 'num alert' : 'num';
    restarts.textContent = pod.restarts ? String(pod.restarts) : '\u2013';

    const age = document.createElement('td');
    age.className = 'num';
    age.textContent = pod.age;

    [name, ready, status, restarts, age].forEach((td) => tr.appendChild(td));
    tr.appendChild(renderActionsCell(pod, category));
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  card.appendChild(table);

  return card;
}

function buildSubtabs() {
  CATEGORY_ORDER.forEach((category) => {
    const tab = document.createElement('button');
    tab.className = 'subtab';

    const label = document.createElement('span');
    label.textContent = CATEGORY_LABELS[category];

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = '0';

    tab.appendChild(label);
    tab.appendChild(count);
    tab.addEventListener('click', () => selectCategory(category));

    subtabEls.set(category, { tab, count });
    el.subtabs.appendChild(tab);
  });
}

function paintSubtabs(buckets) {
  CATEGORY_ORDER.forEach((category) => {
    const entry = subtabEls.get(category);
    const total = (buckets[category] || []).length;

    entry.count.textContent = String(total);
    entry.tab.classList.toggle('active', category === activeCategory);
    entry.tab.classList.toggle('empty', total === 0);
    entry.tab.disabled = total === 0;
  });
}

/**
 * Highlights the clicked tab immediately, then renders on the next frame so the
 * tab state paints before the list is built.
 *
 * @param {string} category
 */
function selectCategory(category) {
  if (category === activeCategory) {
    return;
  }

  activeCategory = category;

  CATEGORY_ORDER.forEach((name) => {
    subtabEls.get(name).tab.classList.toggle('active', name === activeCategory);
  });

  requestAnimationFrame(() => render());
}

function render() {
  const needle = el.filter.value.trim().toLowerCase();
  const visible = needle
    ? pods.filter(
        (pod) =>
          pod.name.toLowerCase().includes(needle) ||
          pod.group.toLowerCase().includes(needle)
      )
    : pods;

  const buckets = {};

  visible.forEach((pod) => {
    (buckets[pod.category] = buckets[pod.category] || []).push(pod);
  });

  // Filtering can empty the selected category; move to one that still matches
  // rather than showing a blank page.
  if (!(buckets[activeCategory] || []).length) {
    const fallback = CATEGORY_ORDER.find((category) => (buckets[category] || []).length);

    if (fallback) {
      activeCategory = fallback;
    }
  }

  paintSubtabs(buckets);

  el.groups.innerHTML = '';

  if (visible.length === 0) {
    showPlaceholder(
      pods.length ? `Nothing matches “${el.filter.value.trim()}”.` : 'No pods in this namespace.'
    );
    el.meta.textContent = '';
    return;
  }

  const rows = buckets[activeCategory] || [];

  closeMenu();
  el.groups.appendChild(renderTable(activeCategory, rows));

  el.meta.textContent =
    `${rows.length} ${CATEGORY_LABELS[activeCategory].toLowerCase()}` +
    (needle ? ` · filtered from ${pods.length} pods` : '');
}

function renderEnvs() {
  const service = services.find((item) => item.name === el.service.value);

  el.env.innerHTML = '';

  (service ? service.envs : []).forEach((env) => {
    const option = document.createElement('option');

    option.value = env.name;
    option.textContent = env.label;
    el.env.appendChild(option);
  });
}

/* ---------- data ---------- */

async function loadPods() {
  if (!el.service.value || !el.env.value) {
    return;
  }

  if (inFlight) {
    inFlight.abort();
  }

  inFlight = new AbortController();
  setLoading(true);

  if (pods.length === 0) {
    showPlaceholder('Loading pods…');
  }

  const params = new URLSearchParams({
    service: el.service.value,
    env: el.env.value,
  });

  try {
    const res = await fetch(`/api/pods?${params}`, { signal: inFlight.signal });
    const body = await res.json();

    if (!res.ok) {
      pods = [];
      showPlaceholder('Could not load pods.');
      el.meta.textContent = '';
      showBanner(body.error.message, body.error.raw);
      return;
    }

    hideBanner();
    pods = body.pods;
    autoscalers = body.autoscalers || {};
    el.target.textContent = `${body.target.namespace} · ${body.target.context}`;
    await loadForwards();
    render();
  } catch (err) {
    if (err.name !== 'AbortError') {
      showPlaceholder('Request failed.');
      showBanner(`Request failed: ${err.message}`);
    }
  } finally {
    inFlight = null;
    setLoading(false);
  }
}

async function init() {
  try {
    const res = await fetch('/api/services');
    const body = await res.json();

    if (!res.ok) {
      showBanner(body.error.message);
      return;
    }

    services = body.services;
    el.status.textContent = 'connected';
    el.status.classList.add('ok');

    services.forEach((service) => {
      const option = document.createElement('option');

      option.value = service.name;
      option.textContent = service.label;
      el.service.appendChild(option);
    });

    renderEnvs();
    await loadPods();
  } catch (err) {
    el.status.textContent = 'backend unreachable';
    showBanner(`Could not load services: ${err.message}`);
  }
}

el.service.addEventListener('change', () => {
  renderEnvs();
  pods = [];
  loadPods();
});
el.env.addEventListener('change', () => {
  pods = [];
  loadPods();
});
el.refresh.addEventListener('click', () => loadPods());
el.filter.addEventListener('input', render);

buildSubtabs();
init();
