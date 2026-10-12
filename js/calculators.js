(function () {
  'use strict';

  const { $, el, initTabs, section } = Aft;

  initTabs();

  /* ---------- helpers ---------- */

  const DAY = 86400000;
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function num(id) {
    const value = parseFloat($(id).value);
    return isFinite(value) ? value : 0;
  }

  function set(id, text) {
    $(id).textContent = text;
  }

  // Indian digit grouping: ₹12,50,000
  function inr(amount) {
    return '₹' + Math.round(amount).toLocaleString('en-IN');
  }

  function inr2(amount) {
    return '₹' + amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function trim(value, digits) {
    return String(parseFloat(value.toFixed(digits == null ? 2 : digits)));
  }

  function plural(n, word) {
    return n.toLocaleString('en-IN') + ' ' + word + (n === 1 ? '' : 's');
  }

  function inWords(amount) {
    if (amount >= 1e7) return trim(amount / 1e7) + ' crore';
    if (amount >= 1e5) return trim(amount / 1e5) + ' lakh';
    if (amount >= 1e3) return trim(amount / 1e3) + ' thousand';
    return '';
  }

  // Recalculates a panel whenever anything inside it changes.
  function live(panelId, calculate) {
    const panel = $(panelId);
    panel.addEventListener('input', calculate);
    panel.addEventListener('change', calculate);
    calculate();
  }

  // A row of chips where exactly one is active. Returns a getter for the active chip's data-value.
  function chips(id) {
    const group = $(id);
    group.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      group.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      group.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return () => group.querySelector('.chip.is-active').dataset.value;
  }

  // Shows "12.5 lakh" style hints under rupee inputs marked with data-words.
  document.querySelectorAll('input[data-words]').forEach((input) => {
    const hint = el('small', { className: 'hint' });
    input.insertAdjacentElement('afterend', hint);
    const sync = () => { hint.textContent = inWords(parseFloat(input.value) || 0); };
    input.addEventListener('input', sync);
    sync();
  });

  function ratioBar(id, first, second) {
    const total = first + second;
    $(id).firstElementChild.style.width = (total > 0 ? (first / total) * 100 : 0) + '%';
  }

  function parseDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  }

  function toInputDate(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function formatDate(date) {
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Whole days between two local dates (UTC maths avoids daylight-saving drift).
  function daysBetween(from, to) {
    return Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / DAY);
  }

  function diffYmd(from, to) {
    let years = to.getFullYear() - from.getFullYear();
    let months = to.getMonth() - from.getMonth();
    let days = to.getDate() - from.getDate();
    if (days < 0) {
      months--;
      days += new Date(to.getFullYear(), to.getMonth(), 0).getDate(); // length of the previous month
    }
    if (months < 0) {
      years--;
      months += 12;
    }
    return { years: years, months: months, days: days };
  }

  function ymdText(diff) {
    return plural(diff.years, 'year') + ', ' + plural(diff.months, 'month') + ', ' + plural(diff.days, 'day');
  }

  /* ---------- GST ---------- */

  section('gst', () => {
    const gstMode = chips('#gstMode');
    const gstRate = chips('#gstRates');
    const gstSupply = chips('#gstSupply');

    live('#panel-gst', () => {
      const custom = gstRate() === 'custom';
      $('#gstCustom').hidden = !custom;
      const rate = custom ? num('#gstCustom') : Number(gstRate());
      const amount = num('#gstAmount');
      const removing = gstMode() === 'remove';
      const net = removing ? amount / (1 + rate / 100) : amount;
      const gst = net * rate / 100;

      set('#gstAmountLabel', removing ? 'Amount including GST (₹)' : 'Amount before GST (₹)');
      set('#gstBigLabel', removing ? 'Amount before GST' : 'Total including GST');
      set('#gstBig', inr2(removing ? net : net + gst));
      set('#gstNet', inr2(net));
      set('#gstTax', inr2(gst));
      set('#gstTaxLabel', 'GST (' + trim(rate) + '%)');
      set('#gstTotal', inr2(net + gst));
      const split = gstSupply() === 'intra';
      $('#gstCgstRow').hidden = $('#gstSgstRow').hidden = !split;
      $('#gstIgstRow').hidden = split;
      set('#gstCgst', inr2(gst / 2));
      set('#gstSgst', inr2(gst / 2));
      set('#gstCgstLabel', 'CGST (' + trim(rate / 2) + '%)');
      set('#gstSgstLabel', 'SGST (' + trim(rate / 2) + '%)');
      set('#gstIgst', inr2(gst));
      set('#gstIgstLabel', 'IGST (' + trim(rate) + '%)');
    });
  });

  /* ---------- EMI ---------- */

  section('emi', () => {
    live('#panel-emi', () => {
      const principal = num('#emiAmount');
      const months = Math.max(0, Math.round(num('#emiTenure') * ($('#emiUnit').value === 'years' ? 12 : 1)));
      const monthlyRate = num('#emiRate') / 1200;
      let emi = 0;
      if (principal > 0 && months > 0) {
        const growth = Math.pow(1 + monthlyRate, months);
        emi = monthlyRate === 0 ? principal / months : (principal * monthlyRate * growth) / (growth - 1);
      }
      const total = emi * months;
      const interest = Math.max(0, total - principal);

      set('#emiBig', inr(emi));
      set('#emiPrincipal', inr(principal));
      set('#emiInterest', inr(interest));
      set('#emiTotal', inr(total));
      ratioBar('#emiBar', principal, interest);

      // Year-by-year schedule.
      const rows = [];
      let balance = principal;
      let yearPrincipal = 0;
      let yearInterest = 0;
      for (let m = 1; m <= months && months <= 600; m++) {
        const interestPart = balance * monthlyRate;
        const principalPart = Math.min(balance, emi - interestPart);
        balance -= principalPart;
        yearPrincipal += principalPart;
        yearInterest += interestPart;
        if (m % 12 === 0 || m === months) {
          rows.push(el('tr', {}, [Math.ceil(m / 12), inr(yearPrincipal), inr(yearInterest), inr(Math.max(0, balance))]
            .map((value) => el('td', { textContent: String(value) }))));
          yearPrincipal = yearInterest = 0;
        }
      }
      $('#emiSchedule').replaceChildren(...rows);
      $('#emiScheduleWrap').hidden = rows.length === 0;
    });
  });

  /* ---------- SIP / lumpsum ---------- */

  section('sip', () => {
    const sipMode = chips('#sipMode');

    live('#panel-sip', () => {
      const lumpsum = sipMode() === 'lumpsum';
      const amount = num('#sipAmount');
      const years = Math.max(0, Math.min(60, num('#sipYears')));
      const rate = num('#sipRate');
      const stepUp = num('#sipStep');
      $('#sipStepRow').hidden = lumpsum;
      set('#sipAmountLabel', lumpsum ? 'One-time investment (₹)' : 'Monthly investment (₹)');

      let invested = 0;
      let value = 0;
      if (lumpsum) {
        invested = amount;
        value = amount * Math.pow(1 + rate / 100, years);
      } else {
        // Each instalment is invested at the start of the month and grows at the monthly rate.
        const monthlyRate = rate / 1200;
        let instalment = amount;
        for (let m = 0; m < Math.round(years * 12); m++) {
          if (m > 0 && m % 12 === 0) instalment *= 1 + stepUp / 100;
          invested += instalment;
          value = (value + instalment) * (1 + monthlyRate);
        }
      }
      set('#sipBig', inr(value));
      set('#sipBigWords', inWords(value));
      set('#sipInvested', inr(invested));
      set('#sipReturns', inr(Math.max(0, value - invested)));
      ratioBar('#sipBar', invested, Math.max(0, value - invested));
    });
  });

  /* ---------- Income tax ---------- */

  section('income-tax', () => {
    // Slabs as announced in Budget 2025 and left unchanged by Budget 2026: [upper limit, rate %].

    const NEW_SLABS = [[400000, 0], [800000, 5], [1200000, 10], [1600000, 15], [2000000, 20], [2400000, 25], [Infinity, 30]];
    const OLD_SLABS = {
      below60: [[250000, 0], [500000, 5], [1000000, 20], [Infinity, 30]],
      senior: [[300000, 0], [500000, 5], [1000000, 20], [Infinity, 30]],
      superSenior: [[500000, 0], [1000000, 20], [Infinity, 30]],
    };
    const SURCHARGE = [[5000000, 10], [10000000, 15], [20000000, 25], [50000000, 37]];
    const CESS = 0.04;

    function slabTax(income, slabs) {
      let tax = 0;
      let lower = 0;
      for (const [upper, rate] of slabs) {
        if (income > lower) tax += (Math.min(income, upper) - lower) * rate / 100;
        lower = upper;
      }
      return tax;
    }

    // Tax after the section 87A rebate.
    function taxAfterRebate(taxable, regime, slabs) {
      const tax = slabTax(taxable, slabs);
      if (regime === 'new') {
        if (taxable <= 1200000) return 0;
        return Math.min(tax, taxable - 1200000); // marginal relief just above ₹12 lakh
      }
      return taxable <= 500000 ? Math.max(0, tax - 12500) : tax;
    }

    // Tax plus surcharge, with marginal relief at each surcharge threshold.
    function taxWithSurcharge(taxable, regime, slabs) {
      const base = taxAfterRebate(taxable, regime, slabs);
      let rate = 0;
      let threshold = 0;
      for (const [limit, percent] of SURCHARGE) {
        if (taxable > limit) {
          rate = regime === 'new' ? Math.min(percent, 25) : percent;
          threshold = limit;
        }
      }
      if (!rate) return { tax: base, surcharge: 0 };
      const atThreshold = taxWithSurcharge(threshold, regime, slabs);
      const capped = Math.min(base * (1 + rate / 100), atThreshold.tax + atThreshold.surcharge + (taxable - threshold));
      return { tax: base, surcharge: Math.max(0, capped - base) };
    }

    function regimeResult(income, deductions, regime, slabs) {
      const taxable = Math.max(0, income - deductions);
      const { tax, surcharge } = taxWithSurcharge(taxable, regime, slabs);
      const cess = (tax + surcharge) * CESS;
      return { taxable: taxable, tax: tax, surcharge: surcharge, cess: cess, total: tax + surcharge + cess };
    }

    function showRegime(prefix, result) {
      set(prefix + 'Total', inr(result.total));
      set(prefix + 'Monthly', inr(result.total / 12) + ' a month');
      set(prefix + 'Taxable', inr(result.taxable));
      set(prefix + 'Tax', inr(result.tax));
      set(prefix + 'Surcharge', inr(result.surcharge));
      set(prefix + 'Cess', inr(result.cess));
    }

    live('#panel-income-tax', () => {
      const income = num('#itIncome');
      const salaried = $('#itSalaried').checked;
      const oldDeductions = (salaried ? 50000 : 0) +
        Math.min(num('#it80c'), 150000) + num('#it80d') + num('#itHra') +
        Math.min(num('#itHome'), 200000) + Math.min(num('#itNps'), 50000) + num('#itOther');

      const fresh = regimeResult(income, salaried ? 75000 : 0, 'new', NEW_SLABS);
      const old = regimeResult(income, oldDeductions, 'old', OLD_SLABS[$('#itAge').value]);
      showRegime('#itNew', fresh);
      showRegime('#itOld', old);

      const gap = Math.round(Math.abs(fresh.total - old.total));
      $('#itNewCard').classList.toggle('is-best', fresh.total <= old.total);
      $('#itOldCard').classList.toggle('is-best', old.total < fresh.total);
      set('#itVerdict', gap === 0
        ? 'Both regimes give the same tax on these numbers.'
        : 'On these numbers the ' + (fresh.total < old.total ? 'new' : 'old') + ' regime is lower by ' + inr(gap) + ' a year.');
    });
  });

  /* ---------- Age ---------- */

  section('age', () => {
    $('#ageOn').value = toInputDate(new Date());

    live('#panel-age', () => {
      const born = parseDate($('#ageDob').value);
      const on = parseDate($('#ageOn').value);
      const valid = born && on && born <= on;
      $('#ageResult').hidden = !valid;
      $('#ageEmpty').hidden = !!valid;
      if (!valid) {
        set('#ageEmpty', born && on ? 'The date of birth is after the “age on” date.' : 'Enter a date of birth to see the age.');
        return;
      }
      const diff = diffYmd(born, on);
      const days = daysBetween(born, on);
      set('#ageBig', ymdText(diff));
      set('#ageMonths', plural(diff.years * 12 + diff.months, 'month') + (diff.days ? ', ' + plural(diff.days, 'day') : ''));
      set('#ageWeeks', plural(Math.floor(days / 7), 'week') + (days % 7 ? ', ' + plural(days % 7, 'day') : ''));
      set('#ageDays', plural(days, 'day'));
      set('#ageBornOn', WEEKDAYS[born.getDay()]);

      let next = new Date(on.getFullYear(), born.getMonth(), born.getDate());
      if (next < on) next = new Date(on.getFullYear() + 1, born.getMonth(), born.getDate());
      const wait = daysBetween(on, next);
      set('#ageNext', wait === 0 ? 'Today — happy birthday!' : 'In ' + plural(wait, 'day') + ' (' + WEEKDAYS[next.getDay()] + ', ' + formatDate(next) + ')');
    });
  });

  /* ---------- Date difference ---------- */

  section('date-difference', () => {
    {
      const today = new Date();
      $('#ddFrom').value = toInputDate(today);
      $('#ddTo').value = toInputDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 30));
      $('#adFrom').value = toInputDate(today);
    }

    live('#panel-date-difference', () => {
      let from = parseDate($('#ddFrom').value);
      let to = parseDate($('#ddTo').value);
      const valid = from && to;
      $('#ddResult').hidden = !valid;
      if (valid) {
        if (from > to) [from, to] = [to, from];
        const inclusive = $('#ddInclusive').checked ? 1 : 0;
        const days = daysBetween(from, to) + inclusive;
        const end = inclusive ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1) : to;

        // Monday–Friday count: whole weeks first, then the leftover days one by one.
        let weekdays = Math.floor(days / 7) * 5;
        for (let i = 0; i < days % 7; i++) {
          const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i).getDay();
          if (day !== 0 && day !== 6) weekdays++;
        }
        set('#ddBig', plural(days, 'day'));
        set('#ddYmd', ymdText(diffYmd(from, end)));
        set('#ddWeeks', plural(Math.floor(days / 7), 'week') + (days % 7 ? ', ' + plural(days % 7, 'day') : ''));
        set('#ddWeekdays', plural(weekdays, 'day'));
        set('#ddWeekend', plural(days - weekdays, 'day'));
      }

      const start = parseDate($('#adFrom').value);
      const shifted = start ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + Math.round(num('#adDays'))) : null;
      set('#adResult', shifted && !isNaN(shifted) ? WEEKDAYS[shifted.getDay()] + ', ' + formatDate(shifted) : '—');
    });
  });

  /* ---------- Percentage ---------- */

  section('percentage', () => {
    live('#panel-percentage', () => {
      const show = (id, value, suffix) => set(id, isFinite(value) ? trim(value) + (suffix || '') : '—');
      show('#pc1Out', num('#pc1A') * num('#pc1B') / 100);
      show('#pc2Out', num('#pc2B') ? num('#pc2A') / num('#pc2B') * 100 : NaN, '%');
      const change = num('#pc3A') ? (num('#pc3B') - num('#pc3A')) / Math.abs(num('#pc3A')) * 100 : NaN;
      set('#pc3Out', isFinite(change) ? (change > 0 ? '+' : '') + trim(change) + '%' : '—');
      set('#pc3Note', isFinite(change) && change !== 0 ? (change > 0 ? 'increase' : 'decrease') : '');
      show('#pc4Out', num('#pc4B') ? num('#pc4A') / num('#pc4B') * 100 : NaN, '%');
    });
  });

  /* ---------- CGPA ---------- */

  section('cgpa', () => {
    const cgDirection = chips('#cgDirection');
    const FORMULAS = {
      '9.5': { toPercent: (c) => c * 9.5, toCgpa: (p) => p / 9.5 },
      '10': { toPercent: (c) => c * 10, toCgpa: (p) => p / 10 },
      'minus': { toPercent: (c) => (c - 0.75) * 10, toCgpa: (p) => p / 10 + 0.75 },
      'custom': { toPercent: (c) => c * num('#cgMultiplier'), toCgpa: (p) => (num('#cgMultiplier') ? p / num('#cgMultiplier') : NaN) },
    };

    function semesterRow(sgpa, credits) {
      const remove = el('button', { type: 'button', className: 'tg-mini', textContent: '×', title: 'Remove semester' });
      remove.setAttribute('aria-label', 'Remove semester');
      const row = el('div', { className: 'sem-row' }, [
        el('span', { className: 'sem-n' }),
        el('input', { type: 'number', className: 'field sem-sgpa', min: '0', max: '10', step: 'any', value: sgpa, placeholder: 'SGPA' }),
        el('input', { type: 'number', className: 'field sem-credits', min: '0', step: 'any', value: credits, placeholder: 'Credits' }),
        remove,
      ]);
      row.querySelector('.sem-sgpa').setAttribute('aria-label', 'SGPA');
      row.querySelector('.sem-credits').setAttribute('aria-label', 'Credits');
      remove.addEventListener('click', () => {
        if ($('#cgRows').children.length > 1) row.remove();
        $('#panel-cgpa').dispatchEvent(new Event('change'));
      });
      return row;
    }
    $('#cgRows').append(semesterRow('8.2', '20'), semesterRow('7.9', '22'));
    $('#cgAddRow').addEventListener('click', () => {
      $('#cgRows').appendChild(semesterRow('', ''));
      $('#panel-cgpa').dispatchEvent(new Event('change'));
    });

    live('#panel-cgpa', () => {
      const formula = FORMULAS[$('#cgFormula').value];
      $('#cgMultiplierRow').hidden = $('#cgFormula').value !== 'custom';
      const toPercent = cgDirection() === 'toPercent';
      const value = num('#cgValue');
      const result = toPercent ? formula.toPercent(value) : formula.toCgpa(value);
      set('#cgValueLabel', toPercent ? 'CGPA' : 'Percentage (%)');
      set('#cgBigLabel', toPercent ? 'Percentage' : 'CGPA');
      set('#cgBig', $('#cgValue').value && isFinite(result) ? trim(Math.max(0, result)) + (toPercent ? '%' : '') : '—');

      // Credit-weighted average of the semesters (equal weight when no credits are given).
      let points = 0;
      let credits = 0;
      Array.from($('#cgRows').children).forEach((row, i) => {
        row.querySelector('.sem-n').textContent = 'Sem ' + (i + 1);
        const sgpa = parseFloat(row.querySelector('.sem-sgpa').value);
        const weight = parseFloat(row.querySelector('.sem-credits').value);
        if (!isFinite(sgpa)) return;
        const w = isFinite(weight) && weight > 0 ? weight : 1;
        points += sgpa * w;
        credits += w;
      });
      const cgpa = credits ? points / credits : NaN;
      set('#cgOverall', isFinite(cgpa) ? trim(cgpa) : '—');
      set('#cgOverallPercent', isFinite(cgpa) && isFinite(formula.toPercent(cgpa)) ? trim(Math.max(0, formula.toPercent(cgpa))) + '%' : '—');
    });
  });
})();
