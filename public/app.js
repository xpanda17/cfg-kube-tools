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

// Kubernetes quantity formats. Checked in the form so a typo shows up next to
// the field instead of coming back as a rejected kubectl call.
const CPU_PATTERN = /^([0-9]+(\.[0-9]+)?|[0-9]+m)$/;
const MEMORY_PATTERN = /^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti|K|M|G|T)?$/;

// RFC 1123 subdomain: the shape Kubernetes requires for a Job name.
const JOB_NAME_PATTERN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const JOB_NAME_MAX = 63;

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
  form: document.getElementById('form-modal'),
  formTitle: document.getElementById('form-title'),
  formBody: document.getElementById('form-body'),
  formFields: document.getElementById('form-fields'),
  formError: document.getElementById('form-error'),
  formCmd: document.getElementById('form-cmd'),
  formOk: document.getElementById('form-ok'),
  formCancel: document.getElementById('form-cancel'),
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

/**
 * Shows the multi-field modal and resolves to the entered values, or to null
 * when cancelled. Fields are described as data so one dialog can serve every
 * form-shaped action rather than each action growing its own markup.
 *
 * @param {Object} options
 * @param {string} options.title
 * @param {string} [options.body]
 * @param {string} options.confirmLabel
 * @param {Array<Object>} options.fields field descriptors — key, label, optional
 *   type ('select', otherwise text), value, placeholder, half (half-width),
 *   options (for selects), validate, invalidMessage and
 *   onChange(value, set, values)
 * @param {Function} options.command values => the kubectl preview
 * @param {Function} [options.validate] values => error string, for rules that
 *   span more than one field
 * @returns {Promise<Object|null>}
 */
function formAction(options) {
  const inputs = new Map();

  el.formTitle.textContent = options.title;
  el.formBody.textContent = options.body || '';
  el.formBody.classList.toggle('hidden', !options.body);
  el.formOk.textContent = options.confirmLabel;
  el.formFields.innerHTML = '';

  const readValues = () => {
    const values = {};

    inputs.forEach((input, key) => {
      values[key] = input.value.trim();
    });

    return values;
  };

  const sync = () => {
    const values = readValues();
    let error = null;

    options.fields.forEach((field) => {
      const valid = !field.validate || field.validate(values[field.key]);

      inputs.get(field.key).parentElement.classList.toggle('invalid', !valid);

      if (!valid && !error) {
        error = field.invalidMessage || `${field.label} is not valid.`;
      }
    });

    if (!error && options.validate) {
      error = options.validate(values);
    }

    el.formError.textContent = error || '';
    el.formError.classList.toggle('hidden', !error);
    el.formOk.disabled = Boolean(error);
    el.formCmd.textContent = options.command(values);
  };

  const set = (key, value) => {
    const input = inputs.get(key);

    if (input) {
      input.value = value;
    }
  };

  options.fields.forEach((field) => {
    const wrap = document.createElement('label');

    wrap.className = `modal-field${field.half ? ' half' : ''}`;

    const caption = document.createElement('span');
    caption.textContent = field.label;
    wrap.appendChild(caption);

    let input;

    if (field.type === 'select') {
      input = document.createElement('select');

      field.options.forEach((option) => {
        const node = document.createElement('option');

        node.value = option.value;
        node.textContent = option.label;
        input.appendChild(node);
      });
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;

      if (field.placeholder) {
        input.placeholder = field.placeholder;
      }
    }

    input.value = field.value || '';
    input.addEventListener(field.type === 'select' ? 'change' : 'input', () => {
      if (field.onChange) {
        field.onChange(input.value, set, readValues());
      }

      sync();
    });

    wrap.appendChild(input);
    el.formFields.appendChild(wrap);
    inputs.set(field.key, input);
  });

  sync();

  // Escape closes without touching returnValue, so clear the previous answer
  // before showing rather than reading a stale 'ok'.
  el.form.returnValue = '';
  el.form.showModal();

  const first = inputs.values().next().value;

  if (first) {
    first.focus();
  }

  return new Promise((resolve) => {
    el.form.addEventListener(
      'close',
      () => {
        resolve(el.form.returnValue === 'ok' ? readValues() : null);
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
    title: `Set Replica — ${pod.deployment}`,
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
    showBanner(`Set Replica failed: ${err.message}`);
  }
}

/**
 * Reads one resource quantity from a container, defensively: the backend may
 * omit containers, or a container may declare neither requests nor limits.
 *
 * @param {Object} container
 * @param {string} bucket 'requests' or 'limits'
 * @param {string} key 'cpu' or 'memory'
 * @returns {string} the quantity, or '' when unset
 */
function resourceValue(container, bucket, key) {
  const group = container && container[bucket];

  return group && group[key] ? String(group[key]) : '';
}

/**
 * Vertical scale: rewrites the CPU and memory requests/limits on the
 * deployment's pod template. A blank field means "leave unchanged", so it is
 * dropped from the payload instead of being sent as an empty quantity.
 *
 * @param {Object} pod
 */
async function updateSpec(pod) {
  const containers = Array.isArray(pod.containers) ? pod.containers : [];
  const selected = containers[0] || {};
  const namespace = el.target.textContent.split(' · ')[0];
  const fields = [];

  // One container is unambiguous, so only ask when there is a real choice.
  if (containers.length > 1) {
    fields.push({
      key: 'container',
      label: 'Container',
      type: 'select',
      value: selected.name,
      options: containers.map((item) => ({ value: item.name, label: item.name })),
      // Prefills belong to the container they were read from; carrying one
      // container's numbers over to another would apply the wrong values.
      onChange: (value, set) => {
        const picked = containers.find((item) => item.name === value) || {};

        set('cpuRequest', resourceValue(picked, 'requests', 'cpu'));
        set('memoryRequest', resourceValue(picked, 'requests', 'memory'));
        set('cpuLimit', resourceValue(picked, 'limits', 'cpu'));
        set('memoryLimit', resourceValue(picked, 'limits', 'memory'));
      },
    });
  }

  // The four quantity fields differ only in the format they accept, which
  // follows from the resource rather than from the bucket.
  const quantity = (key, label, bucket, resource, placeholder) => {
    const pattern = resource === 'cpu' ? CPU_PATTERN : MEMORY_PATTERN;
    const shape =
      resource === 'cpu'
        ? 'a CPU quantity like 100m, 0.5 or 2'
        : 'a memory quantity like 128Mi or 1Gi';

    fields.push({
      key,
      label,
      half: true,
      placeholder,
      value: resourceValue(selected, bucket, resource),
      validate: (value) => value === '' || pattern.test(value),
      invalidMessage: `${label} must be blank or ${shape}.`,
    });
  };

  quantity('cpuRequest', 'CPU request', 'requests', 'cpu', '100m');
  quantity('memoryRequest', 'Memory request', 'requests', 'memory', '128Mi');
  quantity('cpuLimit', 'CPU limit', 'limits', 'cpu', '500m');
  quantity('memoryLimit', 'Memory limit', 'limits', 'memory', '512Mi');

  const flag = (name, cpu, memory) => {
    const parts = [];

    if (cpu) {
      parts.push(`cpu=${cpu}`);
    }

    if (memory) {
      parts.push(`memory=${memory}`);
    }

    return parts.length ? ` --${name}=${parts.join(',')}` : '';
  };

  const answer = await formAction({
    title: `Update Spec — ${pod.deployment}`,
    body:
      `Sets CPU and memory on ${pod.deployment} in ${namespace}. Changing the ` +
      'pod template rolls every pod of the deployment. Leave a field blank to ' +
      'keep its current value.',
    confirmLabel: 'Apply',
    fields,
    validate: (values) =>
      values.cpuRequest || values.memoryRequest || values.cpuLimit || values.memoryLimit
        ? null
        : 'Fill at least one field.',
    command: (values) =>
      `kubectl set resources deployment/${pod.deployment}` +
      (values.container ? ` -c ${values.container}` : '') +
      flag('requests', values.cpuRequest, values.memoryRequest) +
      flag('limits', values.cpuLimit, values.memoryLimit),
  });

  if (!answer) {
    return;
  }

  const requests = {};
  const limits = {};

  if (answer.cpuRequest) {
    requests.cpu = answer.cpuRequest;
  }

  if (answer.memoryRequest) {
    requests.memory = answer.memoryRequest;
  }

  if (answer.cpuLimit) {
    limits.cpu = answer.cpuLimit;
  }

  if (answer.memoryLimit) {
    limits.memory = answer.memoryLimit;
  }

  const payload = {
    service: el.service.value,
    env: el.env.value,
    deployment: pod.deployment,
    requests,
    limits,
  };

  if (answer.container) {
    payload.container = answer.container;
  }

  try {
    const body = await post('/api/spec', payload);

    showBanner(body.message, null, 'ok');
    await loadPods();
  } catch (err) {
    showBanner(`Update spec failed: ${err.message}`);
  }
}

/**
 * Builds the suggested Job name: the CronJob plus a local-time stamp, so two
 * manual runs in the same minute are the only way to collide.
 *
 * @param {string} cronjob
 * @returns {string}
 */
function defaultJobName(cronjob) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const name = `${cronjob}-manual-${stamp}`;

  // A long CronJob name can push the suggestion past the 63-character limit;
  // trim rather than hand the user a value the form would reject.
  return name.length <= JOB_NAME_MAX
    ? name
    : name.slice(0, JOB_NAME_MAX).replace(/[^a-z0-9]+$/, '');
}

/**
 * Creates a one-off Job from a CronJob. The CronJob list is fetched from the
 * cluster because pod.group is only a heuristic parent name.
 *
 * @param {Object} pod
 */
async function createJob(pod) {
  const params = new URLSearchParams({
    service: el.service.value,
    env: el.env.value,
  });

  let cronjobs = [];

  try {
    const res = await fetch(`/api/cronjobs?${params}`);
    const body = await res.json();

    if (!res.ok) {
      throw new Error((body.error && body.error.message) || 'Request failed');
    }

    cronjobs = body.cronjobs || [];
  } catch (err) {
    showBanner(`Could not load CronJobs: ${err.message}`);
    return;
  }

  if (!cronjobs.length) {
    showBanner('No CronJobs found in this namespace.');
    return;
  }

  const match = cronjobs.find((item) => item.name === pod.group) || cronjobs[0];
  let suggested = defaultJobName(match.name);

  const answer = await formAction({
    title: 'Create Job',
    body:
      `Runs a CronJob once, immediately, in ${el.target.textContent.split(' · ')[0]}. ` +
      'The schedule itself is left untouched, including for a suspended CronJob.',
    confirmLabel: 'Create job',
    fields: [
      {
        key: 'cronjob',
        label: 'CronJob',
        type: 'select',
        value: match.name,
        options: cronjobs.map((item) => ({
          value: item.name,
          label:
            `${item.name}${item.schedule ? ` · ${item.schedule}` : ''}` +
            `${item.suspend ? ' · suspended' : ''}`,
        })),
        onChange: (value, set, values) => {
          const next = defaultJobName(value);

          // Only re-derive the name while it is still the untouched suggestion,
          // so a hand-typed name survives switching CronJob.
          if (values.name === suggested) {
            set('name', next);
          }

          suggested = next;
        },
      },
      {
        key: 'name',
        label: 'Job name',
        value: suggested,
        placeholder: suggested,
        validate: (value) => JOB_NAME_PATTERN.test(value) && value.length <= JOB_NAME_MAX,
        invalidMessage:
          `Job name must be lowercase alphanumeric, '-' or '.', start and end ` +
          `with alphanumeric, and be at most ${JOB_NAME_MAX} characters.`,
      },
    ],
    command: (values) => `kubectl create job ${values.name} --from=cronjob/${values.cronjob}`,
  });

  if (!answer) {
    return;
  }

  try {
    const body = await post('/api/job', {
      service: el.service.value,
      env: el.env.value,
      cronjob: answer.cronjob,
      name: answer.name,
    });

    showBanner(body.message, null, 'ok');
    await loadPods();
  } catch (err) {
    showBanner(`Create job failed: ${err.message}`);
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
 * Collects every action a row can offer. This is the single source of truth for
 * the menu: the caller asks first and only draws the trigger when the list is
 * non-empty, so a visible control can never open an empty menu.
 *
 * @param {Object} pod
 * @param {string} category
 * @returns {Array<Object>} descriptors of {label, hint, tone, run}
 */
function podActions(pod, category) {
  const actions = [];

  if (RESTARTABLE.includes(category) && pod.deployment) {
    const siblings = pods.filter((item) => item.deployment === pod.deployment).length;
    const autoscaler = autoscalers[pod.deployment];

    actions.push({
      label: 'Restart deployment',
      hint: `rolls all ${siblings} pod${siblings === 1 ? '' : 's'} of ${pod.deployment}`,
      tone: 'danger',
      run: () => restartDeployment(pod),
    });

    actions.push({
      label: 'Set Replica',
      hint: autoscaler
        ? `autoscaled: min ${autoscaler.min}, max ${autoscaler.max}`
        : 'set the replica count directly',
      run: () => scaleDeployment(pod),
    });
  }

  // Requests and limits live on the Deployment's pod template, so this applies
  // wherever a Deployment exists — load balancers included.
  if (pod.deployment) {
    actions.push({
      label: 'Update Spec',
      hint: 'set CPU and memory requests and limits',
      run: () => updateSpec(pod),
    });
  }

  if (category === 'cronjob') {
    actions.push({
      label: 'Create Job…',
      hint: 'run a CronJob once, now',
      run: () => createJob(pod),
    });
  }

  if (FORWARDABLE.includes(category)) {
    (pod.ports || []).forEach((port) => {
      const active = findForward(pod.name, port);

      actions.push({
        label: active ? `Stop port-forward :${port}` : `Port-forward :${port}`,
        hint: active ? `listening on 127.0.0.1:${port}` : `${port} → 127.0.0.1:${port}`,
        run: () => toggleForward(pod, port),
      });
    });
  }

  return actions;
}

/**
 * Renders the row menu from a precomputed action list. Actions live here rather
 * than as inline buttons so the table stays readable and each action can carry
 * a full, unambiguous label.
 *
 * @param {Array<Object>} actions
 * @param {DOMRect} anchor
 */
function openRowMenu(actions, anchor) {
  closeMenu();

  const menu = document.createElement('div');
  menu.className = 'menu';

  actions.forEach((action) => {
    const item = document.createElement('button');

    item.className = `menu-item${action.tone ? ` ${action.tone}` : ''}`;

    const main = document.createElement('span');
    main.textContent = action.label;
    item.appendChild(main);

    if (action.hint) {
      const sub = document.createElement('span');

      sub.className = 'menu-hint';
      sub.textContent = action.hint;
      item.appendChild(sub);
    }

    item.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenu();
      action.run();
    });

    menu.appendChild(item);
  });

  menu.style.top = `${Math.round(anchor.bottom + 4)}px`;
  menu.style.left = `${Math.round(anchor.right - 240)}px`;
  menu.addEventListener('click', (event) => event.stopPropagation());

  document.body.appendChild(menu);
  openMenu = menu;
}

function renderActionsCell(pod, category) {
  const td = document.createElement('td');
  td.className = 'actions-cell';

  const active = (pod.ports || [])
    .map((port) => findForward(pod.name, port))
    .filter(Boolean);

  active.forEach((session) => {
    const link = document.createElement('a');

    link.className = 'fwd-chip';
    link.href = session.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = `:${session.port} ↗`;
    link.title = `Forwarding to ${session.url}`;
    link.addEventListener('click', (event) => event.stopPropagation());
    td.appendChild(link);
  });

  const actions = podActions(pod, category);

  // Nothing to offer means no trigger at all: a button that opens an empty
  // menu reads as broken.
  if (!actions.length) {
    return td;
  }

  const trigger = document.createElement('button');

  trigger.className = 'row-menu';
  trigger.textContent = '⋯';
  trigger.setAttribute('aria-label', 'Actions');
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();

    if (openMenu) {
      closeMenu();
      return;
    }

    openRowMenu(actions, trigger.getBoundingClientRect());
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
