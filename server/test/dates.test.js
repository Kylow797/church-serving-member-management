import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  saturdaysOf, availabilityWindow, targetMonth, todayIn, addMonths, addDays, diffDays,
  isSaturday, isValidDate, isValidMonth, daysInMonth, lastDayOf, previousMonthsRange,
} from '../dates.js';

test('saturdaysOf: 4-Saturday month', () => {
  assert.deepEqual(saturdaysOf('2026-12'), ['2026-12-05', '2026-12-12', '2026-12-19', '2026-12-26']);
});

test('saturdaysOf: 5-Saturday month', () => {
  assert.deepEqual(saturdaysOf('2027-01'), ['2027-01-02', '2027-01-09', '2027-01-16', '2027-01-23', '2027-01-30']);
});

test('saturdaysOf: month starting on a Saturday', () => {
  assert.deepEqual(saturdaysOf('2026-08'), ['2026-08-01', '2026-08-08', '2026-08-15', '2026-08-22', '2026-08-29']);
});

test('saturdaysOf: leap February starting on Saturday has 5, non-leap has 4', () => {
  assert.deepEqual(saturdaysOf('2020-02'), ['2020-02-01', '2020-02-08', '2020-02-15', '2020-02-22', '2020-02-29']);
  assert.deepEqual(saturdaysOf('2026-02'), ['2026-02-07', '2026-02-14', '2026-02-21', '2026-02-28']);
});

test('saturdaysOf: all results are Saturdays in the month, ascending, for every month of 2026-2028', () => {
  for (let i = 0; i < 36; i++) {
    const m = addMonths('2026-01', i);
    const s = saturdaysOf(m);
    assert.ok(s.length === 4 || s.length === 5, m);
    assert.ok(s.every((d) => d.startsWith(m) && isSaturday(d)), m);
    assert.deepEqual([...s].sort(), s);
    for (let j = 1; j < s.length; j++) assert.equal(diffDays(s[j - 1], s[j]), 7);
  }
});

test('window: December target closes end of November (7 days inclusive)', () => {
  const s = { availability: { openDaysBeforeMonthEnd: 7 } };
  assert.deepEqual(availabilityWindow('2026-12', '2026-11-09', s), { month: '2026-12', opensOn: '2026-11-24', closesOn: '2026-11-30', state: 'upcoming' });
  assert.equal(availabilityWindow('2026-12', '2026-11-23', s).state, 'upcoming');
  assert.equal(availabilityWindow('2026-12', '2026-11-24', s).state, 'open');
  assert.equal(availabilityWindow('2026-12', '2026-11-30', s).state, 'open');
  assert.equal(availabilityWindow('2026-12', '2026-12-01', s).state, 'closed');
});

test('window: January target rolls back across the year boundary', () => {
  const s = { availability: { openDaysBeforeMonthEnd: 7 } };
  const w = availabilityWindow('2027-01', '2026-12-28', s);
  assert.equal(w.opensOn, '2026-12-25');
  assert.equal(w.closesOn, '2026-12-31');
  assert.equal(w.state, 'open');
  assert.equal(availabilityWindow('2027-01', '2027-01-01', s).state, 'closed');
});

test('window: March target uses Feb 28 (non-leap) and Feb 29 (leap)', () => {
  const s = { availability: { openDaysBeforeMonthEnd: 7 } };
  const w1 = availabilityWindow('2027-03', '2027-02-10', s);
  assert.equal(w1.closesOn, '2027-02-28');
  assert.equal(w1.opensOn, '2027-02-22');
  const w2 = availabilityWindow('2028-03', '2028-02-10', s);
  assert.equal(w2.closesOn, '2028-02-29');
  assert.equal(w2.opensOn, '2028-02-23');
  assert.equal(availabilityWindow('2028-03', '2028-02-29', s).state, 'open');
  assert.equal(availabilityWindow('2028-03', '2028-03-01', s).state, 'closed');
});

test('window: custom length, default length and alwaysOpen', () => {
  const w = availabilityWindow('2026-12', '2026-11-27', { availability: { openDaysBeforeMonthEnd: 3 } });
  assert.deepEqual([w.opensOn, w.closesOn, w.state], ['2026-11-28', '2026-11-30', 'upcoming']);
  assert.equal(availabilityWindow('2026-12', '2026-11-24', {}).opensOn, '2026-11-24', 'default 7 days');
  assert.equal(availabilityWindow('2026-12', '2026-01-01', { availability: { alwaysOpen: true } }).state, 'open');
  assert.equal(availabilityWindow('2026-12', '2027-05-01', { availability: { alwaysOpen: true } }).state, 'open');
});

test('targetMonth is always the month after today, across the year end', () => {
  assert.equal(targetMonth('2026-11-09', {}), '2026-12');
  assert.equal(targetMonth('2026-11-30', {}), '2026-12');
  assert.equal(targetMonth('2026-12-01', {}), '2027-01');
  assert.equal(targetMonth('2026-12-31', {}), '2027-01');
});

test('todayIn uses the target timezone, not the host or UTC', () => {
  const t = new Date('2026-11-30T17:00:00Z'); // 01:00 on Dec 1 in Kuala Lumpur (UTC+8)
  assert.equal(todayIn('Asia/Kuala_Lumpur', t), '2026-12-01');
  assert.equal(todayIn('UTC', t), '2026-11-30');
  assert.equal(todayIn('America/Los_Angeles', t), '2026-11-30');
  const edge = new Date('2026-12-31T16:00:00Z'); // exactly midnight Jan 1 in KL
  assert.equal(todayIn('Asia/Kuala_Lumpur', edge), '2027-01-01');
  assert.equal(todayIn('Asia/Kuala_Lumpur', new Date('2026-12-31T15:59:59Z')), '2026-12-31');
  assert.equal(todayIn('Pacific/Auckland', new Date('2026-06-30T12:30:00Z')), '2026-07-01');
});

test('todayIn pads single-digit months and days', () => {
  assert.equal(todayIn('Asia/Kuala_Lumpur', new Date('2026-03-04T04:00:00Z')), '2026-03-04');
});

test('misc helpers: addMonths, addDays, validation, daysInMonth, ranges', () => {
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2027-01', -1), '2026-12');
  assert.equal(addMonths('2026-11', -12), '2025-11');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2027-03-01', -1), '2027-02-28');
  assert.equal(daysInMonth('2028-02'), 29);
  assert.equal(daysInMonth('2100-02'), 28);
  assert.equal(lastDayOf('2026-11'), '2026-11-30');
  assert.ok(isValidDate('2028-02-29') && !isValidDate('2027-02-29') && !isValidDate('2026-13-01') && !isValidDate('2026-1-01') && !isValidDate(null));
  assert.ok(isValidMonth('2026-12') && !isValidMonth('2026-13') && !isValidMonth('2026-00') && !isValidMonth('26-12'));
  assert.deepEqual(previousMonthsRange('2026-12', 3), { from: '2026-09-01', to: '2026-11-30' });
});
