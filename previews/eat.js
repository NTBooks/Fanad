/* ============================================================================
   Storyboard: the Diet module's "eat" command.
   Uses the shared engine (fanad-preview.js) — see its header for the fp.* API.
   To make a preview for another module, copy this file, swap the scenes, and
   point a new <module>.html shell at it.
   ========================================================================== */
FanadPreview.play({
  bot: { name: 'Fanad', logo: 'assets/fanad-logo.svg' },
  brand: { name: 'Fanad', module: 'Eat', logo: 'assets/fanad-logo.svg' },
  cta: { label: 'Demo Signup', href: '/demo' },
  hud: { goal: 2000, unit: 'cal', label: 'Day 1' },
  scenes: [

    // ---- cold open ----
    async (fp) => {
      fp.reset(); fp.hud.day('Day 1');
      await fp.title(
        ['Tracking calories *shouldn’t*', 'feel like a *chore.*'],
        { hold: 2000, sub: 'Meet Fanad Eat — part of Fanad, your no-stress scratchpad.' }
      );
    },

    // ---- Day 1: single food, guessed calories ----
    async (fp) => {
      await fp.sleep(300);
      await fp.user('eat chicken breast 4oz');
      await fp.sleep(320);
      await fp.typing(900);
      const b = fp.bot(
        '<div class="foodline"><span class="food">🍗</span> <span>Chicken breast · 4oz</span></div>' +
        '<div style="margin-top:6px">Fanad’s guess: <span class="cal-badge" id="cc">0 cal</span></div>'
      );
      const cc = b.querySelector('#cc');
      await fp.sleep(260);
      await fp.roll(cc, 0, 185, { dur: 850, fmt: (v) => Math.round(v) + ' cal' }); cc.textContent = '185 cal';
      await fp.sleep(260);
      const q = fp.bot('Log it?<div class="btnrow"><div class="tgbtn primary" id="yes">✅ Yes</div><div class="tgbtn">✏️ Edit</div></div>');
      await fp.sleep(650);
      q.querySelector('#yes').classList.add('press');
      await fp.sleep(360);
      q.querySelector('.btnrow').outerHTML = fp.check('Logged');
      await fp.hud.add(185);
      await fp.sleep(500);
      await fp.title(
        ['It *guesses* the', 'calories for *you.*'],
        { hold: 1700, sub: 'Confirm it or correct it — no forms, no barcodes.' }
      );
    },

    // ---- Day 1: TEACH a meal (Fanad doesn't guess your meals) ----
    async (fp) => {
      await fp.sleep(320);
      await fp.user('save meal breakfast: avocado toast, coffee, melon');
      await fp.sleep(300);
      await fp.typing(850);
      const b = fp.bot(
        '<div class="foodline"><span class="food">🥑</span><span class="food">☕</span><span class="food">🍈</span>' +
        '<span style="margin-left:5px">Saved as <b>“breakfast”</b></span></div>' +
        '<div style="margin-top:8px" id="btot"></div>'
      );
      await fp.sleep(700);
      b.querySelector('#btot').innerHTML =
        fp.check('Counted for you — <b>~405&nbsp;cal</b>') +
        '<div style="margin-top:6px;color:#40794f;font-size:12.5px;font-weight:600">Say “eat breakfast” anytime — I won’t log it till you do.</div>';
      await fp.sleep(950);
      await fp.title(
        ['It *remembers*', 'your *meals.*'],
        { hold: 1650, sub: 'Save a meal once — it never forgets.' }
      );
    },

    // ---- new day ----
    async (fp) => { await fp.dayFlip({ from: 'Day 1', to: 'Day 2' }); },

    // ---- Day 2 morning: weigh-in, same easy way ----
    async (fp) => {
      await fp.sleep(320);
      await fp.user('weight 183.2');
      await fp.sleep(300);
      await fp.typing(780);
      const b = fp.bot(
        '<div class="foodline"><span class="food">⚖️</span> <b>Weigh-in</b> <span class="cal-badge" id="wv">186.5 lb</span></div>' +
        '<div style="margin-top:6px" id="wd"></div>'
      );
      const wv = b.querySelector('#wv');
      await fp.sleep(200);
      await fp.roll(wv, 186.5, 183.2, { dur: 950, fmt: (v) => v.toFixed(1) + ' lb' }); wv.textContent = '183.2 lb';
      await fp.sleep(240);
      b.querySelector('#wd').innerHTML =
        fp.check('Logged') +
        '<div style="margin-top:5px;color:var(--green-deep);font-weight:700;font-size:13px">▼ 3.3 lb since day&nbsp;1</div>';
      await fp.sleep(800);
      await fp.title(
        ['Weight, too.', 'Same deal — *just* *say* *it.*'],
        { hold: 1650, sub: '“weight 183” logs it — the trend does the rest.' }
      );
    },

    // ---- Day 2: recall the saved meal — Fanad expands it ----
    async (fp) => {
      await fp.sleep(320);
      await fp.user('eat breakfast');
      await fp.sleep(280);
      await fp.typing(620);
      const b = fp.bot('Your saved <b>breakfast</b>, logged 👇<div id="ebchips" style="margin-top:6px"></div><div style="margin-top:8px" id="ebc"></div>');
      const chips = b.querySelector('#ebchips');
      const items = [['🥑', 'Avocado toast', 330], ['☕', 'Coffee', 15], ['🍈', 'Melon', 60]];
      for (const [emo, name, cal] of items) {
        const chip = document.createElement('span'); chip.className = 'chip';
        chip.innerHTML = '<span class="food">' + emo + '</span> ' + name + ' <span class="k">' + cal + '</span>';
        chips.appendChild(chip);
        await fp.sleep(300);
      }
      b.querySelector('#ebc').innerHTML = fp.check('Logged · 405 cal');
      await fp.hud.add(405);
      await fp.sleep(600);
      await fp.title(
        ['Then just say', '*“eat* *breakfast.”*'],
        { hold: 1650, sub: 'One word brings back the whole meal.' }
      );
    },

    // ---- Day 2: montage — an editable guess, then the day fills up ----
    async (fp) => {
      await fp.sleep(250);
      // turkey sandwich: Fanad guesses high, user nudges it DOWN
      await fp.user('eat turkey sandwich');
      await fp.sleep(240);
      await fp.typing(720);
      const tb = fp.bot(
        '<div class="foodline"><span class="food">🥪</span> Turkey sandwich <span class="cal-badge" id="tcal">0 cal</span></div>' +
        '<div style="margin-top:8px" id="tbtns"><div class="btnrow"><div class="tgbtn primary">✅ Yes</div><div class="tgbtn" id="tedit">✏️ Edit</div></div></div>'
      );
      const tcal = tb.querySelector('#tcal');
      await fp.sleep(220);
      await fp.roll(tcal, 0, 480, { dur: 800, fmt: (v) => Math.round(v) + ' cal' }); tcal.textContent = '480 cal';
      await fp.sleep(650);
      tb.querySelector('#tedit').classList.add('press');
      await fp.sleep(430);
      await fp.user('350');
      await fp.sleep(220);
      await fp.typing(560);
      await fp.roll(tcal, 480, 350, { dur: 750, fmt: (v) => Math.round(v) + ' cal' }); tcal.textContent = '350 cal';
      tb.querySelector('#tbtns').outerHTML = fp.check('Updated · 350 cal');
      await fp.hud.add(350);
      await fp.sleep(500);
      await fp.title(['Its guess.', 'Your *call.*'], { hold: 1500, sub: 'Nudge any number up or down, anytime.' });

      // two quick items — bubbles get fatter as the day fills
      const meals = [['eat greek yogurt + berries', '🥣', 'Greek yogurt & berries', 180], ['eat salmon and rice', '🍚', 'Salmon & rice', 620]];
      for (const [cmd, emo, name, cal] of meals) {
        await fp.user(cmd);
        await fp.sleep(200);
        await fp.typing(500);
        fp.bot('<div class="foodline"><span class="food">' + emo + '</span> ' + name + ' <span class="cal-badge">' + cal + ' cal</span></div>', { fat: true });
        await fp.hud.add(cal);
        await fp.sleep(430);
      }
      await fp.title(['The day *fills* up.', '*Effortlessly.*'], { hold: 1400 });
    },

    // ---- Day 2: "eat whatever" — off-record, no shame ----
    async (fp) => {
      await fp.sleep(250);
      await fp.user('eat whatever');
      await fp.sleep(300);
      await fp.typing(800);
      fp.hud.amber();
      fp.bot('<div class="foodline"><span class="food">🎉</span> <b>Off-record day.</b></div><div style="margin-top:6px">No numbers today — go enjoy it. See you tomorrow 💛</div>');
      await fp.sleep(1100);
      await fp.title(
        ['Some days you eat _whatever._', 'No *shame.* No *nagging.*'],
        { hold: 1900, sub: 'The one tracker that lets you off the hook.' }
      );
    },

    // ---- payoff: the charts ----
    async (fp) => {
      await fp.overlay(async (root) => {
        root.innerHTML =
          '<div class="dash-head"><h2>Good days. Whatever days. All of them counted.</h2>' +
          '<p>2 weeks in — kept honest, never nagged.</p></div>' +
          '<div class="panels">' +
            '<div class="panel"><h3>Daily calories vs 2000 goal</h3><div id="barsMount"></div>' +
              '<div class="legend"><span><i class="dot g"></i> On-goal day</span><span><i class="dot a"></i> "Eat whatever" day</span></div></div>' +
            '<div class="panel"><h3>Weight</h3><div class="big loss" id="lossNum">−0.0 lbs</div><div id="lineMount"></div></div>' +
          '</div>';
        const DAYS = [1780, 1920, 2050, 1660, 1840, 2600, 1710, 1950, 1780, 2100, 2800, 1620, 1880, 1740];
        const WEIGHTS = [186.5, 186.4, 186.0, 185.7, 185.9, 185.5, 185.0, 184.6, 184.4, 184.0, 183.9, 183.3, 182.9, 182.3];
        const bars = fp.charts.bars(root.querySelector('#barsMount'), DAYS, { goal: 2000, max: 2900, amber: [5, 10], height: 150, goalLabel: '2000' });
        const line = fp.charts.line(root.querySelector('#lineMount'), WEIGHTS, { min: 181.5, max: 187 });
        const lossNum = root.querySelector('#lossNum');
        await fp.sleep(350);
        bars.grow();
        await fp.sleep(900);
        line.draw();
        fp.roll(lossNum, 0, 4.2, { dur: 1500, fmt: (v) => '−' + v.toFixed(1) + ' lbs' });
        await fp.sleep(2200);
      }, { className: 'dash' });
    },

    // ---- close ----
    async (fp) => {
      await fp.title(
        ['No *forms.*', 'No *nagging.*', 'Just tell it what you *ate.*'],
        { hold: 3600, sub: 'Fanad Eat — the easy, no-nag calorie tracker that guesses for you.' }
      );
    },

  ],
});
