// Loads and validates serving.config.yaml. See docs/CONTRACT.md section 3.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

export const DEFAULT_CONFIG_PATH = resolve(import.meta.dirname, '..', 'serving.config.yaml');

export class ConfigError extends Error {
  constructor(errors) {
    super(`Invalid config:\n - ${errors.join('\n - ')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function checkTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function configPath() {
  return process.env.CONFIG_PATH ? resolve(process.env.CONFIG_PATH) : DEFAULT_CONFIG_PATH;
}

/** Parse + default + validate. Throws ConfigError (with .errors[]) on any problem. */
export function parseConfig(text) {
  let raw;
  try {
    raw = parse(text);
  } catch (e) {
    throw new ConfigError([`YAML syntax error: ${e.message}`]);
  }
  if (!isObj(raw)) throw new ConfigError(['Config must be a YAML mapping']);

  const errors = [];
  const err = (m) => errors.push(m);

  // settings
  const rs = isObj(raw.settings) ? raw.settings : {};
  if (raw.settings != null && !isObj(raw.settings)) err('settings must be a mapping');
  const ra = isObj(rs.availability) ? rs.availability : {};
  const settings = {
    churchName: rs.churchName == null ? 'Church' : String(rs.churchName),
    timezone: rs.timezone ?? 'Asia/Kuala_Lumpur',
    adminCode: rs.adminCode == null ? '1234' : String(rs.adminCode),
    availability: {
      openDaysBeforeMonthEnd: ra.openDaysBeforeMonthEnd ?? 7,
      alwaysOpen: ra.alwaysOpen ?? false,
    },
  };
  if (typeof settings.timezone !== 'string' || !checkTimezone(settings.timezone)) {
    err(`settings.timezone "${settings.timezone}" is not a valid IANA timezone`);
  }
  if (settings.adminCode === '') err('settings.adminCode must not be empty');
  const od = settings.availability.openDaysBeforeMonthEnd;
  if (!isInt(od) || od < 1 || od > 28) {
    err('settings.availability.openDaysBeforeMonthEnd must be an integer from 1 to 28');
  }
  if (typeof settings.availability.alwaysOpen !== 'boolean') {
    err('settings.availability.alwaysOpen must be true or false');
  }

  // ministries
  const ministries = [];
  const ministryIds = new Set();
  const roleIds = new Set();
  if (!Array.isArray(raw.ministries) || raw.ministries.length === 0) {
    err('ministries must be a non-empty list');
  } else {
    raw.ministries.forEach((m, i) => {
      const at = `ministries[${i}]`;
      if (!isObj(m)) return err(`${at} must be a mapping`);
      const label = m.id ? `ministry "${m.id}"` : at;
      if (typeof m.id !== 'string' || !SLUG.test(m.id)) err(`${at}.id must be a slug (letters, digits, - or _)`);
      else if (ministryIds.has(m.id)) err(`Duplicate ministry id "${m.id}"`);
      else ministryIds.add(m.id);
      if (typeof m.name !== 'string' || !m.name.trim()) err(`${label}: name is required`);

      let seniority;
      if (m.seniority != null) {
        if (!isObj(m.seniority)) err(`${label}: seniority must be a mapping`);
        else {
          seniority = {};
          for (const k of ['minSenior', 'maxNewcomers']) {
            const v = m.seniority[k];
            if (v == null) continue;
            if (!isInt(v) || v < 0) err(`${label}: seniority.${k} must be an integer >= 0`);
            else seniority[k] = v;
          }
        }
      }

      const roles = [];
      if (!Array.isArray(m.roles)) err(`${label}: roles must be a list`);
      else {
        m.roles.forEach((r, j) => {
          const rat = `${label}.roles[${j}]`;
          if (!isObj(r)) return err(`${rat} must be a mapping`);
          const rl = r.id ? `role "${r.id}"` : rat;
          if (typeof r.id !== 'string' || !SLUG.test(r.id)) err(`${rat}.id must be a slug (letters, digits, - or _)`);
          else if (roleIds.has(r.id)) err(`Duplicate role id "${r.id}" (role ids are global)`);
          else roleIds.add(r.id);
          if (typeof r.name !== 'string' || !r.name.trim()) err(`${rl}: name is required`);
          const okMin = isInt(r.min) && r.min >= 0;
          const okMax = isInt(r.max) && r.max >= 1;
          if (!okMin) err(`${rl}: min must be an integer >= 0`);
          if (!okMax) err(`${rl}: max must be an integer >= 1`);
          if (okMin && okMax && r.min > r.max) err(`${rl}: min (${r.min}) must not exceed max (${r.max})`);
          roles.push({ id: r.id, name: r.name, min: r.min, max: r.max });
        });
      }
      ministries.push({ id: m.id, name: m.name, ...(seniority ? { seniority } : {}), roles });
    });
  }

  // people
  const people = [];
  const personIds = new Set();
  if (!Array.isArray(raw.people)) err('people must be a list');
  else {
    raw.people.forEach((p, i) => {
      const at = `people[${i}]`;
      if (!isObj(p)) return err(`${at} must be a mapping`);
      const label = p.id ? `person "${p.id}"` : at;
      if (typeof p.id !== 'string' || !SLUG.test(p.id)) err(`${at}.id must be a slug (letters, digits, - or _)`);
      else if (personIds.has(p.id)) err(`Duplicate person id "${p.id}"`);
      else personIds.add(p.id);
      if (typeof p.name !== 'string' || !p.name.trim()) err(`${label}: name is required`);
      if (![1, 2, 3].includes(p.rank)) err(`${label}: rank must be 1, 2 or 3`);
      const proles = p.roles ?? [];
      if (!Array.isArray(proles)) err(`${label}: roles must be a list`);
      else {
        for (const r of proles) {
          if (!roleIds.has(r)) err(`${label}: unknown role "${r}"`);
        }
        if (new Set(proles).size !== proles.length) err(`${label}: roles contains duplicates`);
      }
      if (p.maxPerMonth != null && (!isInt(p.maxPerMonth) || p.maxPerMonth < 0)) {
        err(`${label}: maxPerMonth must be an integer >= 0`);
      }
      people.push({
        id: p.id,
        name: p.name,
        rank: p.rank,
        roles: Array.isArray(proles) ? proles : [],
        ...(p.maxPerMonth != null ? { maxPerMonth: p.maxPerMonth } : {}),
      });
    });
  }

  if (errors.length) throw new ConfigError(errors);
  return { settings, ministries, people };
}

export function loadConfig(path = configPath()) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError([`Cannot read config file ${path}: ${e.message}`]);
  }
  return parseConfig(text);
}
