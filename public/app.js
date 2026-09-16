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

// Build and deployment names reach svctl as argv, so they are checked against
// the same RFC 1123 shape here: a typo fails in the form rather than after a
// Jenkins build has already been triggered.
const DEPLOY_NAME_PATTERN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const DEPLOY_NAME_MAX = 63;
const NAME_SHAPE =
  `lowercase alphanumeric, '-' or '.', start and end with alphanumeric, ` +
  `at most ${DEPLOY_NAME_MAX} characters.`;

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
  tabs: document.getElementById('tabs'),
  tabDeploy: document.querySelector('.tab[data-tab="deploy"]'),
  panelPods: document.getElementById('panel-pods'),
  panelDeploy: document.getElementById('panel-deploy'),
  deployBanner: document.getElementById('deploy-banner'),
  deployForm: document.getElementById('deploy-form'),
  deployBuild: document.getElementById('deploy-build'),
  deployBuildHint: document.getElementById('deploy-build-hint'),
  deployEnv: document.getElementById('deploy-env'),
  deployList: document.getElementById('deploy-targets'),
  deployAdd: document.getElementById('deploy-add'),
  deployAddBtn: document.getElementById('deploy-add-btn'),
  deploySkip: document.getElementById('deploy-skip'),
  deployVersion: document.getElementById('deploy-version'),
  deployVersionField: document.getElementById('deploy-version-field'),
  deployVersionHint: document.getElementById('deploy-version-hint'),
  deployError: document.getElementById('deploy-error'),
  deployPreview: document.getElementById('deploy-preview'),
  deployRun: document.getElementById('deploy-run'),
  deployRunView: document.getElementById('deploy-run-view'),
  runStatus: document.getElementById('run-status'),
  runTitle: document.getElementById('run-title'),
  runElapsed: document.getElementById('run-elapsed'),
  runCancel: document.getElementById('run-cancel'),
  runBack: document.getElementById('run-back'),
  runVersion: document.getElementById('run-version'),
  runVersionValue: document.getElementById('run-version-value'),
  runVersionNote: document.getElementById('run-version-note'),
  runSteps: document.getElementById('run-steps'),
  runNote: document.getElementById('run-note'),
  runLog: document.getElementById('run-log'),
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

/**
 * Paints a banner. Each top-level panel owns one — only the visible panel's
 * banner can be read, so the node is a parameter rather than a fixed element.
 *
 * @param {HTMLElement} node
 * @param {string} message
 * @param {string} [detail] raw output, shown in a <pre>
 * @param {string} [tone] 'ok' for a success banner
 */
function paintBanner(node, message, detail, tone) {
  node.classList.remove('hidden');
  node.classList.toggle('ok', tone === 'ok');
  node.innerHTML = '';

  const text = document.createElement('div');
  text.textContent = message;
  node.appendChild(text);

  if (detail) {
    const pre = document.createElement('pre');
    pre.textContent = detail;
    node.appendChild(pre);
  }
}

function showBanner(message, detail, tone) {
  paintBanner(el.banner, message, detail, tone);
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
 * @param {string} [options.tone] 'danger' to mark the confirm button destructive
 * @returns {Promise<Object|null>}
 */
function formAction(options) {
  const inputs = new Map();

  el.formTitle.textContent = options.title;
  el.formBody.textContent = options.body || '';
  el.formBody.classList.toggle('hidden', !options.body);
  el.formOk.textContent = options.confirmLabel;
  el.formOk.classList.toggle('danger', options.tone === 'danger');
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
 * Reads the namespace's CronJobs, or resolves to null after showing the banner
 * when the list cannot be read or is empty — better than opening a form whose
 * only field would have nothing to choose from.
 *
 * @returns {Promise<Array<Object>|null>}
 */
async function fetchCronjobs() {
  const params = new URLSearchParams({
    service: el.service.value,
    env: el.env.value,
  });

  try {
    const res = await fetch(`/api/cronjobs?${params}`);
    const body = await res.json();

    if (!res.ok) {
      throw new Error((body.error && body.error.message) || 'Request failed');
    }

    const cronjobs = body.cronjobs || [];

    if (!cronjobs.length) {
      showBanner('No CronJobs found in this namespace.');
      return null;
    }

    return cronjobs;
  } catch (err) {
    showBanner(`Could not load CronJobs: ${err.message}`);
    return null;
  }
}

/**
 * Labels a CronJob option with the state the choice is made from: schedule plus
 * whether it is currently running or suspended.
 *
 * @param {Object} cronjob
 * @returns {string}
 */
function cronjobLabel(cronjob) {
  return (
    `${cronjob.name}${cronjob.schedule ? ` · ${cronjob.schedule}` : ''}` +
    `${cronjob.suspend ? ' · suspended' : ' · active'}`
  );
}

/**
 * Creates a one-off Job from a CronJob. The CronJob list is fetched from the
 * cluster because pod.group is only a heuristic parent name.
 *
 * @param {Object} pod
 */
async function createJob(pod) {
  const cronjobs = await fetchCronjobs();

  if (!cronjobs) {
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
        options: cronjobs.map((item) => ({ value: item.name, label: cronjobLabel(item) })),
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

/**
 * Suspends the single Job the clicked pod belongs to. A pod only exists while
 * its Job is running, so suspend is the only direction worth offering from a
 * row; resuming is a CronJob-level action.
 *
 * @param {Object} pod
 */
async function stopJob(pod) {
  const namespace = el.target.textContent.split(' · ')[0];
  const ok = await confirmAction({
    title: `Stop job ${pod.job}?`,
    body:
      `Suspends only this Job in ${namespace}. The CronJob's schedule is left ` +
      `alone, so the next scheduled run still fires. The Job's running pods are ` +
      `deleted, so work in progress is lost and starts again from the beginning ` +
      `if the Job is ever resumed. This pod then disappears from the list — ` +
      `resuming is done from “Enable / Disable + Stop Jobs…” → ` +
      `“Active (resume)”, which needs some CronJob pod still on screen ` +
      `to open the menu from.`,
    command: `kubectl patch job ${pod.job} -p '{"spec":{"suspend":true}}'`,
    confirmLabel: 'Stop job',
  });

  if (!ok) {
    return;
  }

  try {
    const body = await post('/api/job/suspend', {
      service: el.service.value,
      env: el.env.value,
      job: pod.job,
      suspend: true,
    });

    showBanner(body.message, null, 'ok');
    await loadPods();
  } catch (err) {
    showBanner(`Stop job failed: ${err.message}`);
  }
}

/**
 * Suspends or resumes a CronJob's schedule. includeActiveJobs also patches the
 * Jobs that are running right now, which is a separate menu item because
 * suspending a running Job is destructive in a way suspending a schedule is not.
 *
 * @param {Object} pod
 * @param {boolean} includeActiveJobs
 */
async function toggleSchedule(pod, includeActiveJobs) {
  const cronjobs = await fetchCronjobs();

  if (!cronjobs) {
    return;
  }

  // pod.group is a heuristic parent name, so a miss is expected.
  const match = cronjobs.find((item) => item.name === pod.group) || cronjobs[0];
  // Preselect the change the user most likely came to make: the opposite of the
  // CronJob's current state. The select holds strings, so the boolean is one.
  const stateFor = (cronjob) => String(!cronjob.suspend);
  const namespace = el.target.textContent.split(' · ')[0];
  let suggested = stateFor(match);

  const answer = await formAction({
    title: includeActiveJobs ? 'Enable / Disable + Stop Jobs' : 'Enable / Disable Schedule',
    body: includeActiveJobs
      ? `Patches the CronJob in ${namespace} and every Job it has running right ` +
        'now. Suspending a running Job deletes its live pods, so the work in ' +
        'progress is lost and starts again from the beginning when it resumes.'
      : `Patches only the CronJob's schedule in ${namespace}. Jobs that are ` +
        'running now are left alone and finish normally; this affects future runs.',
    confirmLabel: includeActiveJobs ? 'Apply and stop jobs' : 'Apply',
    tone: includeActiveJobs ? 'danger' : null,
    fields: [
      {
        key: 'cronjob',
        label: 'CronJob',
        type: 'select',
        value: match.name,
        options: cronjobs.map((item) => ({ value: item.name, label: cronjobLabel(item) })),
        onChange: (value, set, values) => {
          const picked = cronjobs.find((item) => item.name === value) || match;
          const next = stateFor(picked);

          // Only re-derive while the state is still the untouched suggestion, so
          // a deliberate choice survives switching CronJob.
          if (values.suspend === suggested) {
            set('suspend', next);
          }

          suggested = next;
        },
      },
      {
        key: 'suspend',
        label: 'State',
        type: 'select',
        value: suggested,
        options: [
          { value: 'false', label: 'Active (resume)' },
          { value: 'true', label: 'Suspended (disable)' },
        ],
      },
    ],
    command: (values) => {
      const patch =
        `kubectl patch cronjob ${values.cronjob} -p '{"spec":{"suspend":${values.suspend}}}'`;

      // The running Jobs are named by the server, so the second line stays
      // generic rather than inventing names the user would try to read.
      return includeActiveJobs
        ? `${patch}\n# plus the same patch on each running job`
        : patch;
    },
  });

  if (!answer) {
    return;
  }

  try {
    const body = await post('/api/cronjob/suspend', {
      service: el.service.value,
      env: el.env.value,
      cronjob: answer.cronjob,
      // A select value is always a string; the endpoint wants a real boolean.
      suspend: answer.suspend === 'true',
      includeActiveJobs,
    });

    showBanner(body.steps.join(' · '), null, 'ok');
    await loadPods();
  } catch (err) {
    showBanner(`Suspend failed: ${err.message}`);
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

    // The Job name comes from the pod's owner reference, which may be missing.
    if (pod.job) {
      actions.push({
        label: 'Stop this job…',
        hint: 'suspend the run this pod belongs to',
        tone: 'danger',
        run: () => stopJob(pod),
      });
    }

    actions.push({
      label: 'Enable / Disable Schedule…',
      hint: 'suspend or resume future runs',
      run: () => toggleSchedule(pod, false),
    });

    actions.push({
      label: 'Enable / Disable + Stop Jobs…',
      hint: 'also suspends jobs running now',
      tone: 'danger',
      run: () => toggleSchedule(pod, true),
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
  el.deployEnv.innerHTML = '';

  (service ? service.envs : []).forEach((env) => {
    [el.env, el.deployEnv].forEach((select) => {
      const option = document.createElement('option');

      option.value = env.name;
      option.textContent = env.label;
      select.appendChild(option);
    });
  });

  // The deploy form and the pod list share one target, so the two selects are
  // two views of the same value rather than two independent choices.
  el.deployEnv.value = el.env.value;
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
    // The deploy form offers the deployments these pods belong to, so it is
    // rebuilt whenever the pod list is.
    refreshDeployTargets();
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
    syncDeployBuild();
    await loadPods();
    // A deploy outlives the page: if one is still running, show it instead of
    // an empty form.
    await reattachRunningJob();
  } catch (err) {
    el.status.textContent = 'backend unreachable';
    showBanner(`Could not load services: ${err.message}`);
  }
}

el.service.addEventListener('change', () => {
  renderEnvs();
  syncDeployBuild();
  pods = [];
  loadPods();
});
el.env.addEventListener('change', () => {
  el.deployEnv.value = el.env.value;
  pods = [];
  loadPods();
});
el.refresh.addEventListener('click', () => loadPods());
el.filter.addEventListener('input', render);

/* ---------- top-level tabs ---------- */

// Exactly one panel is visible at a time. The toolbar sits above both.
const PANELS = {
  pods: el.panelPods,
  deploy: el.panelDeploy,
};

let activeTab = 'pods';

/**
 * Swaps the top-level panel.
 *
 * Service and Environment stay visible on both tabs on purpose: the deploy form
 * deploys to the service and env the pod list is pointed at, and a second pair
 * of selects would be a second source of truth for "where am I acting?" — the
 * failure mode being a deploy to an env the user is not looking at. Search and
 * Refresh only act on the pod table, so they hide with it.
 *
 * @param {string} name 'pods' or 'deploy'
 */
function selectTab(name) {
  if (!PANELS[name] || name === activeTab) {
    return;
  }

  activeTab = name;

  // The row menu is fixed-positioned on <body>, so it would otherwise hang over
  // the panel that replaced the table it belongs to.
  closeMenu();

  Object.keys(PANELS).forEach((key) => {
    PANELS[key].classList.toggle('hidden', key !== activeTab);
  });

  el.tabs.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === activeTab);
  });

  document.querySelectorAll('.toolbar .pods-only').forEach((node) => {
    node.classList.toggle('hidden', activeTab !== 'pods');
  });

  if (activeTab === 'deploy') {
    refreshDeployTargets();
  }
}

/* ---------- stable deployment: form ---------- */

// svctl is run from the repo checkout, which is how the team types it today.
const SVCTL = 'cli/svctl jenkins run-pipeline';

// kube-deploy's <cluster_context>. 'default' means "the service's own cluster".
const DEPLOY_CLUSTER = 'default';

// With no containerize step nothing produces a version, so the server demands
// an explicit one. It deliberately refuses 'latest': during a fan-out that can
// resolve to a teammate's build, which is the failure this whole screen exists
// to prevent.
//
// Only the argv-safety rule is enforced here. The server also checks the token
// shape against a pattern the config can override, so a stricter client check
// would reject versions the server would have accepted.
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Output is capped so a chatty pipeline cannot grow the DOM without bound. The
// head is dropped because the tail is the part being read.
const LOG_MAX_LINES = 5000;

const STATUS_TONE = {
  pending: 'warn',
  queued: 'warn',
  running: 'warn',
  skipped: 'warn',
  succeeded: 'ok',
  failed: 'bad',
  cancelled: 'bad',
};

let deployTargets = [];
let deployJob = null;
let deployStream = null;
let deployTicker = null;
let stepTimeNodes = [];
let logStep = -1;
let buildSuggestion = '';

function showDeployBanner(message, detail, tone) {
  paintBanner(el.deployBanner, message, detail, tone);
}

function hideDeployBanner() {
  el.deployBanner.classList.add('hidden');
}

function validDeployName(value) {
  return DEPLOY_NAME_PATTERN.test(value) && value.length <= DEPLOY_NAME_MAX;
}

/**
 * The name `containerize` runs with. It is not a deployment name — athena
 * builds the image that athenaapp and the workers deploy — so it comes from the
 * registry's `build` field, falling back to the service name for entries that
 * do not declare one.
 *
 * @param {Object} service
 * @returns {string}
 */
function serviceBuild(service) {
  return (service && (service.build || service.name)) || '';
}

/**
 * Prefills the build name from the selected service, but only while the field
 * still holds the previous suggestion, so a hand-typed build survives switching
 * service — the same rule the Job name follows.
 */
function syncDeployBuild() {
  const service = services.find((item) => item.name === el.service.value);
  const next = serviceBuild(service);
  const current = el.deployBuild.value.trim();

  if (!current || current === buildSuggestion) {
    el.deployBuild.value = next;
  }

  buildSuggestion = next;
  el.deployBuildHint.textContent = next
    ? `containerize runs with “${next}” — not the deployment name.`
    : 'The service name containerize runs with.';

  syncDeployForm();
}

function selectedDeployments() {
  return deployTargets.filter((target) => target.checked).map((target) => target.name);
}

/**
 * Renders the exact commands the run will execute. Used for the live preview
 * and, unchanged, for the confirm dialog.
 *
 * @returns {string}
 */
function deployCommands() {
  const env = el.deployEnv.value || '<env>';
  const build = el.deployBuild.value.trim() || '<build>';
  const names = selectedDeployments();
  const lines = [];

  if (!el.deploySkip.checked) {
    lines.push(`${SVCTL} containerize ${build} ${env}`);
  }

  // The point of the two-step run: every deployment gets the one version
  // containerize resolved, rather than each resolving its own 'latest'.
  const version = el.deploySkip.checked
    ? el.deployVersion.value.trim() || '<version>'
    : '<version from containerize>';

  (names.length ? names : ['<deployment>']).forEach((name) => {
    lines.push(`${SVCTL} kube-deploy ${DEPLOY_CLUSTER} ${name} ${env} ${version}`);
  });

  return lines.join('\n');
}

/**
 * Validates the form the way the backend will.
 *
 * @returns {string|null} the first problem, or null when the form is runnable
 */
function deployProblem() {
  const build = el.deployBuild.value.trim();

  if (!build) {
    return 'Build name is required.';
  }

  if (!validDeployName(build)) {
    return `Build name must be ${NAME_SHAPE}`;
  }

  if (!el.deployEnv.value) {
    return 'Pick an environment.';
  }

  if (el.deploySkip.checked) {
    const version = el.deployVersion.value.trim();

    if (!version) {
      return 'Skipping containerize needs the image version to deploy.';
    }

    if (!VERSION_PATTERN.test(version)) {
      return 'Image version must be alphanumeric with “.”, “-” or “_”.';
    }
  }

  const names = selectedDeployments();

  if (!names.length) {
    return 'Pick at least one deployment.';
  }

  const bad = names.find((name) => !validDeployName(name));

  return bad ? `“${bad}” is not a valid deployment name.` : null;
}

function syncDeployForm() {
  const problem = deployProblem();
  const env = el.deployEnv.value || 'stg';

  el.deployVersionField.classList.toggle('hidden', !el.deploySkip.checked);
  el.deployVersion.placeholder = `${env}-20260915T141826-cf2118ba`;
  el.deployVersionHint.textContent =
    `The image to roll out, as containerize printed it — usually ` +
    `${env}-YYYYMMDDTHHMMSS-<sha>. “latest” is refused on purpose: in a ` +
    `fan-out it can resolve to somebody else's build.`;

  el.deployError.textContent = problem || '';
  el.deployError.classList.toggle('hidden', !problem);
  el.deployRun.disabled = Boolean(problem);
  el.deployPreview.textContent = deployCommands();
}

/**
 * Rebuilds the deployment list from the pods currently loaded, keeping both
 * what the user ticked and the names they added by hand.
 */
function refreshDeployTargets() {
  const checked = new Set(selectedDeployments());
  const counts = new Map();

  pods.forEach((pod) => {
    if (pod.deployment) {
      counts.set(pod.deployment, (counts.get(pod.deployment) || 0) + 1);
    }
  });

  const next = Array.from(counts.keys())
    .sort()
    .map((name) => ({
      name,
      pods: counts.get(name),
      manual: false,
      checked: checked.has(name),
    }));

  // A deployment scaled to zero owns no pod to be discovered from, so a typed
  // name has to survive every reload of the pod list.
  deployTargets
    .filter((target) => target.manual && !counts.has(target.name))
    .forEach((target) => next.push(target));

  deployTargets = next;
  renderDeployTargets();
  syncDeployForm();
}

function renderDeployTargets() {
  el.deployList.innerHTML = '';

  if (!deployTargets.length) {
    const empty = document.createElement('div');

    empty.className = 'target-empty';
    empty.textContent =
      'No deployments found for this service and environment — add one by name below.';
    el.deployList.appendChild(empty);

    return;
  }

  deployTargets.forEach((target) => {
    const row = document.createElement('label');

    row.className = target.checked ? 'target on' : 'target';

    const box = document.createElement('input');

    box.type = 'checkbox';
    box.checked = target.checked;
    box.addEventListener('change', () => {
      target.checked = box.checked;
      row.classList.toggle('on', box.checked);
      syncDeployForm();
    });

    const name = document.createElement('span');

    name.className = 'target-name';
    name.textContent = target.name;

    const note = document.createElement('span');

    note.className = 'target-note';
    note.textContent = target.manual
      ? 'added by name'
      : `${target.pods} pod${target.pods === 1 ? '' : 's'}`;

    row.appendChild(box);
    row.appendChild(name);
    row.appendChild(note);

    if (target.manual) {
      const remove = document.createElement('button');

      remove.type = 'button';
      remove.className = 'target-remove';
      remove.textContent = '✕';
      remove.setAttribute('aria-label', `Remove ${target.name}`);
      remove.addEventListener('click', (event) => {
        // The row is a <label>, so a click inside it would toggle the checkbox.
        event.preventDefault();
        event.stopPropagation();

        deployTargets = deployTargets.filter((item) => item !== target);
        renderDeployTargets();
        syncDeployForm();
      });

      row.appendChild(remove);
    }

    el.deployList.appendChild(row);
  });
}

/**
 * Adds a deployment the pod list cannot know about — typically one scaled to
 * zero, which is exactly the case discovery misses.
 */
function addDeployTarget() {
  const name = el.deployAdd.value.trim();

  if (!name) {
    return;
  }

  if (!validDeployName(name)) {
    showDeployBanner(`“${name}” is not a valid deployment name. It must be ${NAME_SHAPE}`);
    return;
  }

  const existing = deployTargets.find((target) => target.name === name);

  if (existing) {
    existing.checked = true;
  } else {
    deployTargets.push({ name, pods: 0, manual: true, checked: true });
  }

  el.deployAdd.value = '';
  hideDeployBanner();
  renderDeployTargets();
  syncDeployForm();
}

/* ---------- stable deployment: running ---------- */

function showDeployForm() {
  el.deployForm.classList.remove('hidden');
  el.deployRunView.classList.add('hidden');
}

function showDeployRun() {
  el.deployForm.classList.add('hidden');
  el.deployRunView.classList.remove('hidden');
}

function setRunNote(text) {
  el.runNote.textContent = text;
}

function clearRunLog() {
  el.runLog.innerHTML = '';
  logStep = -1;
}

function stepLabel(index) {
  const step = deployJob && deployJob.steps ? deployJob.steps[index] : null;

  return step && step.name ? step.name : `step ${Number(index) + 1}`;
}

/**
 * Appends one line of raw process output. Auto-scroll happens only when the
 * user is already at the bottom, so scrolling up to read is never undone.
 *
 * @param {number} stepIndex
 * @param {string} text
 */
function appendLogLine(stepIndex, text) {
  const pane = el.runLog;
  // Measured before the append: afterwards the pane is taller and everybody
  // looks like they have scrolled up.
  const following = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24;

  if (stepIndex !== logStep) {
    const separator = document.createElement('div');

    separator.className = 'log-sep';
    separator.textContent = `── ${stepLabel(stepIndex)} ──`;
    pane.appendChild(separator);
    logStep = stepIndex;
  }

  const line = document.createElement('div');

  line.className = 'log-line';
  // Raw process output: textContent, never markup.
  line.textContent = text;
  pane.appendChild(line);

  while (pane.childElementCount > LOG_MAX_LINES && pane.firstChild) {
    pane.removeChild(pane.firstChild);
  }

  if (following) {
    pane.scrollTop = pane.scrollHeight;
  }
}

/**
 * Formats a duration. Timestamps arrive as ISO strings; a missing end means the
 * thing is still running, which is the live case.
 *
 * @param {string} from
 * @param {string} [to]
 * @returns {string}
 */
function elapsedText(from, to) {
  const start = Date.parse(from);

  if (!Number.isFinite(start)) {
    return '';
  }

  const end = to ? Date.parse(to) : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function stepTime(step) {
  return step.startedAt ? elapsedText(step.startedAt, step.finishedAt) : '';
}

/**
 * Ticks the clocks only. The step rows themselves are left alone so a
 * once-a-second repaint cannot fight with the log pane or the user's selection.
 */
function renderRunTimes() {
  if (!deployJob) {
    return;
  }

  el.runElapsed.textContent = elapsedText(deployJob.createdAt, deployJob.finishedAt);
  stepTimeNodes.forEach((entry) => {
    entry.node.textContent = stepTime(entry.step);
  });
}

function renderRunSteps() {
  el.runSteps.innerHTML = '';
  stepTimeNodes = [];

  (deployJob.steps || []).forEach((step) => {
    // Steps arrive addressed by index, so a gap is possible before the server
    // has described them all.
    if (!step) {
      return;
    }

    const status = step.status || 'pending';
    const row = document.createElement('div');

    row.className = `step ${status}`;

    const head = document.createElement('div');

    head.className = 'step-head';

    const name = document.createElement('span');

    name.className = 'step-name';
    name.textContent = step.name || 'step';
    head.appendChild(name);
    head.appendChild(pill(status, STATUS_TONE[status] || 'warn'));

    const time = document.createElement('span');

    time.className = 'step-time';
    time.textContent = stepTime(step);
    head.appendChild(time);
    stepTimeNodes.push({ node: time, step });

    if (step.jenkinsUrl) {
      const link = document.createElement('a');

      link.className = 'step-link';
      link.href = step.jenkinsUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = 'Jenkins ↗';
      head.appendChild(link);
    }

    if (Number.isInteger(step.exitCode) && step.exitCode !== 0) {
      const code = document.createElement('span');

      code.className = 'step-exit';
      code.textContent = `exit ${step.exitCode}`;
      head.appendChild(code);
    }

    if (step.droppedLines) {
      const dropped = document.createElement('span');

      // Nobody should read a truncated log as a complete one.
      dropped.className = 'step-exit';
      dropped.textContent = `${step.droppedLines} earlier lines dropped`;
      head.appendChild(dropped);
    }

    const command = document.createElement('div');

    command.className = 'step-cmd';
    // The argv the server actually spawned — the authoritative version of the
    // preview shown on the form. A kube-deploy step has none until containerize
    // has produced the version that goes in it.
    command.textContent = step.command
      ? step.command.join(' ')
      : 'argv is completed once containerize resolves the image version';

    row.appendChild(head);
    row.appendChild(command);
    el.runSteps.appendChild(row);
  });
}

function renderRun() {
  if (!deployJob) {
    return;
  }

  const running = deployJob.status === 'running';
  const names = deployJob.deployments || [];

  el.runStatus.innerHTML = '';
  el.runStatus.appendChild(pill(deployJob.status, STATUS_TONE[deployJob.status] || 'warn'));

  el.runTitle.textContent =
    `${deployJob.build || el.deployBuild.value.trim()} → ${names.join(', ')}` +
    `${deployJob.env ? ` · ${deployJob.env}` : ''}`;

  el.runCancel.classList.toggle('hidden', !running);
  el.runBack.classList.toggle('hidden', running);
  // A run outlives the tab it was started from, so the tab itself carries the
  // "something is happening" marker.
  el.tabDeploy.classList.toggle('running', running);

  // The resolved version is the proof that every deployment got one image.
  el.runVersion.classList.toggle('hidden', !deployJob.version);

  if (deployJob.version) {
    el.runVersionValue.textContent = deployJob.version;
    el.runVersionNote.textContent =
      `the one image all ${names.length} deployment${names.length === 1 ? '' : 's'} receive`;
  }

  renderRunSteps();
  renderRunTimes();

  // The server explains a failure in one sentence — a half-finished fan-out is
  // not something to leave the user to infer from exit codes.
  if (deployJob.error) {
    showDeployBanner(deployJob.error);
  }

  if (running && !deployTicker) {
    deployTicker = setInterval(renderRunTimes, 1000);
  } else if (!running && deployTicker) {
    clearInterval(deployTicker);
    deployTicker = null;
  }
}

/**
 * Parses an SSE payload, tolerating a malformed frame rather than letting one
 * bad event kill the listener.
 *
 * @param {MessageEvent} event
 * @returns {Object|null}
 */
function parseEvent(event) {
  try {
    return JSON.parse(event.data);
  } catch (err) {
    return null;
  }
}

function closeDeployStream() {
  if (deployStream) {
    deployStream.close();
    deployStream = null;
  }
}

/**
 * Re-reads the job once the stream ends, so the final status, version and exit
 * codes are what the server recorded rather than the last event that arrived.
 */
async function refreshDeployJob() {
  if (!deployJob) {
    return;
  }

  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(deployJob.id)}`);
    const body = await res.json();

    if (res.ok && body.job) {
      deployJob = body.job;
    }
  } catch (err) {
    // Keep whatever the stream gave us.
  }

  renderRun();
}

/**
 * Opens the SSE stream for a job. The server replays its whole line buffer on
 * every connect — including the reconnect EventSource makes on its own after a
 * dropped connection — so the pane is cleared on 'open' instead of ending up
 * with a second copy of the run.
 *
 * @param {string} id
 */
function openDeployStream(id) {
  closeDeployStream();

  const source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/stream`);

  deployStream = source;

  source.addEventListener('open', () => {
    setRunNote('');
    clearRunLog();
  });

  source.addEventListener('line', (event) => {
    const data = parseEvent(event);

    if (data) {
      appendLogLine(data.stepIndex, data.text);
    }
  });

  source.addEventListener('step', (event) => {
    const data = parseEvent(event);

    if (data && deployJob) {
      deployJob.steps = deployJob.steps || [];
      deployJob.steps[data.stepIndex] = data.step;
      renderRun();
    }
  });

  source.addEventListener('job', (event) => {
    const data = parseEvent(event);

    if (data && data.job) {
      deployJob = data.job;
      renderRun();
    }
  });

  source.addEventListener('end', () => {
    // The run is over; closing stops EventSource from reconnecting and
    // replaying the whole log again.
    closeDeployStream();
    refreshDeployJob();
  });

  source.addEventListener('error', () => {
    // EventSource retries by itself, so only a closed source is terminal.
    if (source.readyState === EventSource.CLOSED) {
      deployStream = null;
      setRunNote('Stream closed — reload to reattach.');
    } else {
      setRunNote('Reconnecting…');
    }
  });
}

/**
 * Shows the run view for a job and starts streaming it. The job is fetched
 * first so the steps are on screen before the first event arrives — unless the
 * caller already has it, which POST /api/deploy returns.
 *
 * @param {string} id
 * @param {Object} [known] the job, when the caller already has it
 */
async function attachDeployJob(id, known) {
  deployJob = known || { id, status: 'running', steps: [], deployments: [], version: null };

  if (!known) {
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
      const body = await res.json();

      if (res.ok && body.job) {
        deployJob = body.job;
      }
    } catch (err) {
      // The stream carries the same metadata; a failed prefetch is not fatal.
    }
  }

  clearRunLog();
  hideDeployBanner();
  showDeployRun();
  renderRun();
  openDeployStream(id);
}

/**
 * Reattaches to a run that is still going — after a page reload, or after the
 * 409 that says the server is busy with a deployment someone else started.
 *
 * @returns {Promise<boolean>} whether a running job was found
 */
async function reattachRunningJob() {
  try {
    const res = await fetch('/api/jobs');
    const body = await res.json();

    if (!res.ok) {
      return false;
    }

    const running = (body.jobs || []).find((job) => job.status === 'running');

    if (!running) {
      return false;
    }

    await attachDeployJob(running.id);

    return true;
  } catch (err) {
    // The deploy endpoints may be unreachable; the rest of the page still works.
    return false;
  }
}

/**
 * Drops the finished run and returns to the form. Only reachable once the job
 * has stopped, so nothing is being abandoned mid-flight.
 */
function resetDeploy() {
  closeDeployStream();

  if (deployTicker) {
    clearInterval(deployTicker);
    deployTicker = null;
  }

  deployJob = null;
  stepTimeNodes = [];
  el.runSteps.innerHTML = '';
  el.tabDeploy.classList.remove('running');
  clearRunLog();
  setRunNote('');
  showDeployForm();
  refreshDeployTargets();
}

/**
 * Confirms, then starts the run. This deploys to a real cluster and takes
 * minutes, so the confirm shows the full command list rather than a summary.
 */
async function startDeploy() {
  if (deployProblem()) {
    return;
  }

  const names = selectedDeployments();
  const env = el.deployEnv.value;
  const skip = el.deploySkip.checked;
  const build = el.deployBuild.value.trim();
  const namespace = el.target.textContent.split(' · ')[0] || env;
  const total = names.length + (skip ? 0 : 1);

  const ok = await confirmAction({
    title: `Deploy to ${env}?`,
    body:
      `This runs ${total} Jenkins pipeline${total === 1 ? '' : 's'} for real. ` +
      (skip
        ? `Containerize is skipped: every deployment is rolled to the image ` +
          `${el.deployVersion.value.trim()}. `
        : `Containerize builds ${build} first, then every deployment gets that one version. `) +
      `${names.length} deployment${names.length === 1 ? '' : 's'} in ${namespace} ` +
      `(${names.join(', ')}) will be rolled. This takes minutes and cannot be undone from here.`,
    command: deployCommands(),
    confirmLabel: 'Run deployment',
  });

  if (!ok) {
    return;
  }

  const payload = {
    service: el.service.value,
    env,
    build,
    deployments: names,
  };

  if (skip) {
    payload.skipContainerize = true;
    // The server requires this when containerize is skipped; there is nothing
    // else that could produce a version.
    payload.version = el.deployVersion.value.trim();
  }

  el.deployRun.disabled = true;

  try {
    const body = await post('/api/deploy', payload);

    hideDeployBanner();
    await attachDeployJob(body.id, body.job);
  } catch (err) {
    showDeployBanner(`Could not start the deployment: ${err.message}`);
    syncDeployForm();

    // A 409 means a run is already in flight; showing that run is more useful
    // than the error on its own.
    await reattachRunningJob();
  }
}

/**
 * Cancels the live run. Half a fan-out is a real state to land in, so this
 * confirms and says so.
 */
async function cancelDeploy() {
  if (!deployJob) {
    return;
  }

  const ok = await confirmAction({
    title: 'Cancel this run?',
    body:
      'Stops the pipeline that is running now. Deployments that already ' +
      'finished stay on the new image, so the service can be left half ' +
      'deployed — the rest then have to be deployed by hand, or by running ' +
      'this again with “Skip containerize”.',
    command: `POST /api/jobs/${deployJob.id}/cancel`,
    confirmLabel: 'Cancel run',
  });

  if (!ok) {
    return;
  }

  try {
    await post(`/api/jobs/${encodeURIComponent(deployJob.id)}/cancel`, {});
  } catch (err) {
    showDeployBanner(`Cancel failed: ${err.message}`);
  }
}

el.tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');

  if (tab && tab.dataset.tab) {
    selectTab(tab.dataset.tab);
  }
});

el.deployEnv.addEventListener('change', () => {
  if (el.deployEnv.value === el.env.value) {
    return;
  }

  // One target for the whole app: the toolbar follows the form, and reloading
  // the pods reloads the deployment list this form offers.
  el.env.value = el.deployEnv.value;
  pods = [];
  loadPods();
  syncDeployForm();
});
el.deployBuild.addEventListener('input', syncDeployForm);
el.deploySkip.addEventListener('change', syncDeployForm);
el.deployVersion.addEventListener('input', syncDeployForm);
el.deployAddBtn.addEventListener('click', addDeployTarget);
el.deployAdd.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addDeployTarget();
  }
});
el.deployRun.addEventListener('click', startDeploy);
el.runCancel.addEventListener('click', cancelDeploy);
el.runBack.addEventListener('click', resetDeploy);

buildSubtabs();
// Paint the deploy form before any data arrives, so the tab is never blank.
refreshDeployTargets();
init();
