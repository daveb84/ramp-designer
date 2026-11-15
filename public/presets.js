'use strict';

/*
 * Presets: everything set on the page (every input, every choice of units, the skateboard position and the rider's
 * moves), saved in this browser's local storage and loaded again. Values are kept in the units they were entered in,
 * along with those units, so loading one never converts anything.
 */

/** The presets that come with the page. The page opens on the first. */
const DEFAULT_PRESETS = {
  presets: [
    {
      id: 'default',
      name: 'Default',
      state: {
        values: {
          height: '3',
          radius: '5',
          coping: '2.375',
          'coping-above-deck': '10',
          'coping-from-ramp': '10',
          'deck-length': '810',
          wheelbase: '445',
          'axle-height': '49',
          'wheel-diameter': '52',
          playback: '70',
          speed: '9.5',
          'rider-mass': '70',
          'front-foot': '-60',
          'back-foot': '80',
          'rider-height': '175',
          crouch: '30',
          lean: '0',
        },
        choices: {
          units: 'ft',
          'coping-units': 'in',
          'protrusion-units': 'mm',
          'board-units': 'mm',
          'board-position': 'top',
          'rider-model': 'pivot',
          'speed-units': 'mph',
          'rider-mass-units': 'kg',
          'foot-units': 'mm',
        },
        moves: [
          { when: 'up', at: '102', delay: '0', frontWeight: '50', twist: '', twistTime: '' },
          { when: 'stop', at: '', delay: '0.2', frontWeight: '30', twist: '60', twistTime: '0.1' },
          { when: 'down', at: '90', delay: '0', frontWeight: '50', twist: '', twistTime: '' },
        ],
      },
    },
  ],
};

const presetSelect = document.getElementById('page-preset');
const presetStatus = document.getElementById('preset-status');
const deletePresetButton = document.getElementById('delete-preset');
const saveAsPanel = document.getElementById('save-as');
const saveAsName = document.getElementById('save-as-name');

const builtInPreset = (preset) => DEFAULT_PRESETS.presets.find(({ id }) => id === preset);
const firstPreset = () => DEFAULT_PRESETS.presets[0].id;

// Saved presets: { [preset id]: { name, state } }. Ids of presets saved under a new name start "saved:". Storage can
// be unavailable (a private window, say), when nothing is kept between visits.
const SAVED_PRESETS_KEY = 'ramp-designer.presets';
function loadSavedPresets() {
  try {
    return JSON.parse(localStorage.getItem(SAVED_PRESETS_KEY)) ?? {};
  } catch {
    return {};
  }
}
function storeSavedPresets(saved) {
  try {
    localStorage.setItem(SAVED_PRESETS_KEY, JSON.stringify(saved));
    return true;
  } catch {
    return false;
  }
}
let savedPresets = loadSavedPresets();

/** A preset's state: the saved version if there is one, otherwise the built-in one. */
const presetState = (preset) => savedPresets[preset]?.state ?? builtInPreset(preset)?.state;
const presetName = (preset) => savedPresets[preset]?.name ?? builtInPreset(preset)?.name ?? preset;

/** Shows a preset in the dropdown and sets everything on the page from it. */
function loadPreset(preset) {
  showPresetOptions(preset);
  applyPageState(presetState(preset));
}

/** Saves everything on the page under a preset, and says so. */
function savePreset(preset, name) {
  savedPresets = { ...savedPresets, [preset]: { name, state: pageState() } };
  const stored = storeSavedPresets(savedPresets);
  showPresetOptions(preset);
  showPresetStatus(stored ? `Saved as "${name}"` : "Couldn't save: this browser isn't keeping data for the page");
}

/** Deletes the saved version of a preset. */
function deletePreset(preset) {
  const { [preset]: deleted, ...rest } = savedPresets;
  savedPresets = rest;
  storeSavedPresets(savedPresets);
}

/** The page's form controls, other than the moves table, which is kept separately. */
function pageControls() {
  return [...document.querySelectorAll('form input, form select')].filter((control) => !movesBody.contains(control));
}

/** Everything set on the page. */
function pageState() {
  const values = {};
  const choices = {};
  for (const control of pageControls()) {
    if (control.type === 'radio') {
      if (control.checked) choices[control.name] = control.value;
    } else if (control.id) {
      values[control.id] = control.value;
    }
  }
  return { values, choices, moves: copyMoves(riderMoves) };
}

/** Whether the page offers this choice: a preset can hold one the page no longer has. */
const hasChoice = (name, value) => [...document.getElementsByName(name)].some((radio) => radio.value === value);

/** Sets everything on the page from a saved state, then redraws. Anything the state doesn't mention is left alone. */
function applyPageState(savedState) {
  const state = withBoardUnits(savedState);
  for (const control of pageControls()) {
    if (control.type === 'radio') {
      if (hasChoice(control.name, state.choices[control.name])) control.checked = control.value === state.choices[control.name];
    } else if (control.id in state.values) {
      control.value = state.values[control.id];
    }
  }
  for (const [group, unitGroup] of Object.entries(UNIT_GROUPS)) {
    if (unitGroup.radioName in state.choices) unitGroup.current = state.choices[unitGroup.radioName];
    showUnitLabels(group);
  }
  riderMoves = (state.moves ?? []).map(movesWithTwist());
  renderMoves();
  update();
}

/**
 * Converts moves saved when kicks were set as a push from each foot (as a share of body weight) into the twist those
 * pushes made, taking the rider's weight to be in the middle of the stance. Reads the board and rider from the page.
 */
function movesWithTwist() {
  const board = {
    wheelbase: toBaseUnits(wheelbaseInput, 'board'),
    deckLength: toBaseUnits(deckLengthInput, 'board'),
    frontFootOffset: toBaseUnits(frontFootInput, 'feet'),
    backFootOffset: toBaseUnits(backFootInput, 'feet'),
    riderMass: toBaseUnits(riderMassInput, 'riderMass'),
  };
  const { backFoot, frontFoot } = footPositions({ board });
  const middle = (backFoot + frontFoot) / 2;
  const weight = board.riderMass * 9.81;
  return (move) => {
    if (!('kickBack' in move)) return { ...move };
    const { kickBack, kickFront, kickTime, ...rest } = move;
    const extra = { back: (Number(kickBack) || 0) / 100 - 0.5, front: (Number(kickFront) || 0) / 100 - 0.5 };
    // Pushing into the deck ahead of the middle turns the nose down.
    const twist = -(extra.front * weight * toM(frontFoot - middle) + extra.back * weight * toM(backFoot - middle));
    const timed = Number(kickTime) > 0;
    return { ...rest, twist: timed ? String(Math.round(twist)) : '', twistTime: timed ? kickTime : '' };
  };
}

/**
 * Converts a state saved when the deck length and wheelbase had units of their own, and the deck underside height
 * was set directly, to the one set of board units (mm): the underside height becomes an axle height, keeping the
 * page's wheel diameter.
 */
function withBoardUnits(state) {
  const { choices = {}, values = {} } = state;
  if (!('wheelbase-units' in choices) && !('board-height-units' in choices)) return state;
  const toMm = (value, unit) => (value === undefined ? undefined : String(Number((Number(value) * UNITS[unit].basePerUnit * 10).toFixed(1))));
  const { 'wheelbase-units': lengthUnit = 'in', 'board-height-units': heightUnit = 'in', ...otherChoices } = choices;
  const { 'board-height': underside, ...otherValues } = values;
  const converted = { ...otherValues, wheelbase: toMm(values.wheelbase, lengthUnit), 'deck-length': toMm(values['deck-length'], lengthUnit) };
  if (underside !== undefined) {
    const wheelDiameterMm = Number(wheelDiameterInput.value);
    converted['axle-height'] = String(Math.max(1, Number(toMm(underside, heightUnit)) - wheelDiameterMm / 2));
  }
  for (const key of Object.keys(converted)) if (converted[key] === undefined) delete converted[key];
  return { ...state, values: converted, choices: { ...otherChoices, 'board-units': 'mm' } };
}

/** Fills the preset dropdown: the built-in presets, then any saved under a name of their own. */
function showPresetOptions(selected) {
  const builtIn = DEFAULT_PRESETS.presets.map(({ id }) => id);
  const saved = Object.keys(savedPresets).filter((id) => !builtInPreset(id))
    .sort((a, b) => presetName(a).localeCompare(presetName(b)));
  presetSelect.replaceChildren(...[...builtIn, ...saved]
    .map((id) => new Option(presetName(id), id, false, id === selected)));
  presetSelect.value = selected;
  // Only a preset you've saved can be deleted.
  deletePresetButton.disabled = !(selected in savedPresets);
}

/** Shows a message by the presets for a few seconds. */
function showPresetStatus(message) {
  presetStatus.textContent = message;
  clearTimeout(showPresetStatus.timer);
  showPresetStatus.timer = setTimeout(() => { presetStatus.textContent = ''; }, 3000);
}

presetSelect.addEventListener('change', () => loadPreset(presetSelect.value));

/**
 * Deletes the saved version of the selected preset, once confirmed. A built-in preset goes back to its own values; one
 * saved under a name of its own goes, and the page switches to the first preset.
 */
deletePresetButton.addEventListener('click', () => {
  const preset = presetSelect.value;
  const name = presetName(preset);
  const builtIn = Boolean(builtInPreset(preset));
  const question = builtIn ? `Delete your saved "${name}" and go back to the built-in one?` : `Delete the preset "${name}"?`;
  if (!(preset in savedPresets) || !window.confirm(question)) return;
  deletePreset(preset);
  loadPreset(builtIn ? preset : firstPreset());
  showPresetStatus(builtIn ? `Deleted your saved "${name}"` : `Deleted "${name}"`);
});
document.getElementById('save-preset').addEventListener('click', () => savePreset(presetSelect.value, presetName(presetSelect.value)));

// Save as: a name box, saving under a built-in preset's id when the name matches one, otherwise as a new preset.
const closeSaveAs = () => {
  saveAsPanel.hidden = true;
  saveAsName.value = '';
};
const confirmSaveAs = () => {
  const name = saveAsName.value.trim();
  if (!name) {
    saveAsName.focus();
    return;
  }
  const builtIn = DEFAULT_PRESETS.presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
  savePreset(builtIn?.id ?? `saved:${name}`, builtIn?.name ?? name);
  closeSaveAs();
};
document.getElementById('save-preset-as').addEventListener('click', () => {
  saveAsPanel.hidden = false;
  saveAsName.focus();
});
document.getElementById('save-as-confirm').addEventListener('click', confirmSaveAs);
document.getElementById('save-as-cancel').addEventListener('click', closeSaveAs);
saveAsName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') confirmSaveAs();
  if (event.key === 'Escape') closeSaveAs();
});
