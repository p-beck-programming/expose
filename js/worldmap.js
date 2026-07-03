/* ═══════════════════════════════════════════════════════════════
   EXPOSÉ — worldmap.js
   Ambient background: a dotted flat (equirectangular) world map
   with flight-path arcs, travelling signal pulses, and a LIVE
   day/night terminator computed from the sun's actual position
   at the moment of viewing (declination + subsolar longitude,
   recomputed every 60s).

   Self-contained — no dependencies. Usage (end of <body>):
     <script src="js/worldmap.js"></script>
     <script>WorldMap.mount();</script>

   Layering: the canvas is position:fixed, z-index:-1, so it sits
   above the body background but under all content. Panels with
   opaque backgrounds (sidebar, cards) cover it; open space shows
   the map. Colors come from the active palette's CSS variables
   and refresh automatically when data-palette changes.
   ═══════════════════════════════════════════════════════════════ */

const WorldMap = (() => {

  /* ── Landmasses: [lon,lat] outlines (approximate — rendered as a
        dot grid, so coarse shapes read fine). ── */
  const LAND = [
    // North America
    [[-168,66],[-165,60],[-157,58],[-152,60],[-146,60],[-136,57],[-131,54],[-125,49],
     [-124,43],[-122,38],[-117,33],[-113,29],[-109,23],[-107,24],[-105,20],[-96,16],
     [-92,15],[-88,13],[-84,9],[-79,9],[-82,12],[-86,14],[-89,16],[-90,20],[-87,21],
     [-90,22],[-97,26],[-94,29],[-89,30],[-84,30],[-82,28],[-80,25],[-80,28],[-81,31],
     [-76,35],[-74,40],[-70,42],[-66,44],[-60,46],[-65,49],[-59,52],[-63,57],[-70,60],
     [-77,62],[-82,66],[-90,69],[-97,72],[-107,73],[-117,74],[-127,71],[-136,69],
     [-148,71],[-157,71],[-165,68]],
    // Greenland
    [[-45,60],[-53,65],[-57,71],[-61,76],[-56,80],[-45,83],[-32,83],[-21,79],[-19,75],
     [-24,70],[-33,67],[-40,63]],
    // South America
    [[-77,8],[-72,12],[-64,11],[-60,8],[-54,6],[-50,2],[-44,-2],[-37,-5],[-35,-9],
     [-39,-15],[-41,-22],[-48,-26],[-54,-31],[-58,-35],[-62,-40],[-65,-46],[-69,-51],
     [-68,-55],[-73,-52],[-73,-45],[-73,-38],[-71,-31],[-70,-21],[-76,-15],[-81,-6],
     [-80,0],[-78,4]],
    // Eurasia (Europe + Asia + Arabia + India + SE-Asia mainland)
    [[-9,36],[-9,43],[-2,45],[-5,48],[-2,50],[3,51],[7,54],[8,57],[5,59],[5,62],
     [10,64],[14,68],[20,70],[26,71],[30,70],[36,67],[44,68],[54,69],[68,70],[73,72],
     [85,74],[95,76],[105,77],[113,76],[125,73],[135,72],[143,72],[152,70],[160,69],
     [170,67],[178,65],[175,62],[170,60],[163,60],[160,53],[156,51],[152,55],[147,55],
     [142,54],[137,49],[134,43],[130,42],[128,39],[126,35],[124,38],[120,38],[122,31],
     [120,27],[114,22],[108,20],[106,16],[108,11],[105,9],[101,7],[98,10],[97,15],
     [94,17],[91,22],[88,21],[85,19],[82,16],[80,12],[77,8],[73,15],[70,21],[67,24],
     [62,25],[57,27],[56,26],[59,22],[55,17],[52,14],[48,14],[44,12.5],[41,17],[38,22],
     [35,28],[34.5,29.5],[34,31],[35,34],[36,36],[33,36],[30,36.5],[27,37],[26,40],
     [24,37],[21,38],[19,42],[14,45],[13,44],[15,42],[18,40],[16,38],[14,40],[11,42],
     [10,44],[7,44],[4,43],[3,41],[0,39],[-2,37],[-5,36]],
    // Africa
    [[-6,35],[-10,30],[-15,27],[-17,21],[-17,15],[-15,11],[-11,7],[-7,4.5],[-3,5],
     [1,6],[5,6],[9,4],[9,0],[13,-5],[12,-10],[13,-17],[14,-23],[15,-28],[18,-33],
     [20,-34.8],[25,-34],[28,-32],[32,-29],[35,-24],[35,-19],[40,-16],[40,-11],[39,-7],
     [41,-2],[44,0],[48,5],[51,8],[51,12],[43,11.5],[40,15],[37,20],[35,25],[33,28],
     [32,31],[27,31.5],[20,32],[15,32],[10,34],[10,37],[5,37],[0,36]],
    // Australia
    [[114,-22],[113,-26],[115,-34],[119,-35],[124,-33],[129,-32],[133,-32],[138,-35],
     [141,-38],[146,-39],[150,-37],[153,-32],[153,-27],[151,-24],[146,-19],[143,-14],
     [142,-11],[138,-16],[136,-12],[131,-12],[126,-14],[122,-17]],
    // Islands
    [[-5,50],[-6,53],[-5,56],[-3,58],[-1,57],[1,52],[-2,50]],                    // Great Britain
    [[-10,52],[-10,55],[-6,55],[-6,52]],                                          // Ireland
    [[-22,64],[-18,66],[-14,65],[-18,63]],                                        // Iceland
    [[44,-25],[43,-20],[46,-14],[50,-15],[47,-22],[45,-25]],                      // Madagascar
    [[80,6],[81,9],[82,7],[80,5]],                                                // Sri Lanka
    [[130,31],[130,34],[135,34],[137,34.3],[140,35.2],[141,40],[142,45],[145,44],
     [141,42],[140.5,37],[136,35],[132,31]],                                      // Japan
    [[120,16],[122,18],[124,13],[125,7],[122,8],[120,14]],                        // Philippines
    [[109,0],[110,4],[115,6],[119,4],[117,-1],[113,-3]],                          // Borneo
    [[95,5],[98,3],[103,-1],[106,-5],[103,-5],[98,1]],                            // Sumatra
    [[105,-7],[112,-7],[114,-8],[108,-8]],                                        // Java
    [[131,-1],[136,-2],[141,-3],[146,-6],[150,-9],[147,-10],[141,-8],[135,-4],[131,-2]], // New Guinea
    [[173,-35],[176,-38],[178,-38],[175,-41],[173,-39]],                          // NZ North
    [[167,-46],[170,-44],[173,-41],[171,-43],[166,-46]],                          // NZ South
    [[-84,22],[-80,23],[-75,20],[-79,22]],                                        // Cuba
  ];
  /* Inland seas / bays carved out of the polygons above */
  const HOLES = [
    [[-94,57],[-92,61],[-88,64],[-82,63],[-78,59],[-80,55],[-86,53],[-92,54]],    // Hudson Bay
    [[11,54],[19,54],[28,59],[26,63],[19,62],[17,58],[11,55]],                    // Baltic Sea
    [[29,41.5],[33,42],[38,42.5],[41,42],[40,44],[36,45],[33,45.5],[30,46],[28,44],[27.5,42]], // Black Sea
    [[50,37],[54,38],[54,42],[52,47],[48,47],[47,42],[48,38]],                    // Caspian Sea
  ];

  /* ── Network: hub cities + routes for the flight-path arcs ── */
  const CITY = {
    nashville:[-86.8,36.2], nyc:[-74,40.7], la:[-118.2,34], seattle:[-122.3,47.6],
    mexico:[-99.1,19.4], saopaulo:[-46.6,-23.5], buenosaires:[-58.4,-34.6],
    london:[-0.1,51.5], paris:[2.3,48.9], berlin:[13.4,52.5], moscow:[37.6,55.8],
    cairo:[31.2,30], lagos:[3.4,6.5], joburg:[28,-26.2], dubai:[55.3,25.3],
    delhi:[77.2,28.6], singapore:[103.8,1.4], hongkong:[114.2,22.3],
    beijing:[116.4,39.9], tokyo:[139.7,35.7], sydney:[151.2,-33.9],
  };
  const ROUTES = [
    ['nashville','nyc'], ['la','nashville'], ['seattle','nyc'], ['nyc','london'],
    ['la','mexico'], ['mexico','saopaulo'], ['saopaulo','buenosaires'],
    ['saopaulo','lagos'], ['nyc','paris'], ['london','cairo'], ['paris','moscow'],
    ['berlin','dubai'], ['cairo','joburg'], ['dubai','delhi'], ['delhi','singapore'],
    ['singapore','hongkong'], ['hongkong','tokyo'], ['moscow','beijing'],
    ['beijing','tokyo'], ['singapore','sydney'],
  ];

  /* ── State ── */
  let canvas, ctx, W, H, S, OX, OY;
  let base = null;                 // offscreen: dots + arcs + city markers
  let night = null;                // { path: Path2D, sun: [x,y], calcAt: ms }
  let pulses = [];                 // per-route animation state
  let colors = {};
  let raf = 0;
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Projection (equirectangular, scaled to cover the viewport) ── */
  function project(lon, lat) {
    return [(lon + 180) * S + OX, (90 - lat) * S + OY];
  }

  /* ── Palette-aware colors, read from the live CSS variables ── */
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = name => cs.getPropertyValue(name).trim();
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    colors = {
      light,
      land:  rgba(v('--faint') || '#5A6577', light ? 0.55 : 0.5),
      arc:   rgba(v('--acc')   || '#F0A33C', light ? 0.20 : 0.14),
      city:  rgba(v('--acc')   || '#F0A33C', light ? 0.55 : 0.45),
      pulse: v('--ok') || '#46C28E',
      night: light ? 'rgba(26,34,48,0.13)' : 'rgba(0,0,0,0.40)',
      dusk:  light ? 'rgba(26,34,48,0.08)' : 'rgba(0,0,0,0.18)',
      term:  rgba(v('--acc') || '#F0A33C', light ? 0.35 : 0.28),
      sun:   rgba(v('--acc-hi') || v('--acc') || '#FFC163', light ? 0.16 : 0.10),
    };
  }
  function rgba(color, a) {
    let m = color.match(/^#([0-9a-f]{3})$/i);
    if (m) color = '#' + [...m[1]].map(c => c + c).join('');
    m = color.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    }
    m = color.match(/^rgba?\(([^)]+)\)/);
    if (m) {
      const [r, g, b] = m[1].split(',').map(s => parseFloat(s));
      return `rgba(${r},${g},${b},${a})`;
    }
    return color;
  }

  /* ── Point-in-polygon (ray casting) over land minus holes ── */
  function inPoly(poly, lon, lat) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > lat) !== (yj > lat) &&
          lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function isLand(lon, lat) {
    for (const h of HOLES) if (inPoly(h, lon, lat)) return false;
    for (const p of LAND)  if (inPoly(p, lon, lat)) return true;
    return false;
  }

  /* ── Base layer: dot-grid map + arcs + cities (rebuilt on resize/palette) ── */
  function buildBase() {
    base = document.createElement('canvas');
    base.width = W; base.height = H;
    const b = base.getContext('2d');

    // Land dots
    const step = Math.max(5, Math.round(S * 1.55)); // grid pitch tracks map scale
    b.fillStyle = colors.land;
    for (let y = step / 2; y < H; y += step) {
      const lat = 90 - (y - OY) / S;
      if (lat > 85 || lat < -60) continue;          // skip empty polar bands
      for (let x = step / 2; x < W; x += step) {
        const lon = (x - OX) / S - 180;
        if (lon < -180 || lon > 180) continue;
        if (!isLand(lon, lat)) continue;
        b.beginPath();
        b.arc(x, y, step * 0.22, 0, Math.PI * 2);
        b.fill();
      }
    }

    // Flight arcs
    b.strokeStyle = colors.arc;
    b.lineWidth = 1;
    for (const p of pulses) {
      b.beginPath();
      b.moveTo(p.a[0], p.a[1]);
      b.quadraticCurveTo(p.c[0], p.c[1], p.b[0], p.b[1]);
      b.stroke();
    }

    // City markers
    b.fillStyle = colors.city;
    for (const key in CITY) {
      const [x, y] = project(CITY[key][0], CITY[key][1]);
      b.beginPath();
      b.arc(x, y, 1.6, 0, Math.PI * 2);
      b.fill();
    }
  }

  /* ── Route pulse setup ── */
  function buildPulses() {
    const now = performance.now();
    pulses = ROUTES.map(([ka, kb], i) => {
      const a = project(...CITY[ka]);
      const b = project(...CITY[kb]);
      // Arc control point: midpoint lifted perpendicular to the chord, always upward.
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const dist = Math.hypot(dx, dy) || 1;
      let nx = -dy / dist, ny = dx / dist;
      if (ny > 0) { nx = -nx; ny = -ny; }
      const lift = Math.min(dist * 0.22, S * 14);
      return {
        a, b, c: [mx + nx * lift, my + ny * lift],
        dur:  9000 + (i * 977) % 7000,             // 9–16s per crossing
        wait: 2500 + (i * 1733) % 9000,            // 2.5–11.5s idle between trips
        t0:   now + (i * 653) % 12000,             // staggered first departures
      };
    });
  }
  function bezier(p, t) {
    const u = 1 - t;
    return [
      u * u * p.a[0] + 2 * u * t * p.c[0] + t * t * p.b[0],
      u * u * p.a[1] + 2 * u * t * p.c[1] + t * t * p.b[1],
    ];
  }

  /* ── Day/night terminator (the "livetime" line) ──
     Sun declination from day-of-year, subsolar longitude from UTC time.
     For each longitude the terminator latitude satisfies
       tan(φ) = -cos(H) / tan(δ),  H = lon - subsolar lon.
     The polygon is closed around whichever pole is in darkness.       */
  function computeNight() {
    const now  = new Date();
    const start = Date.UTC(now.getUTCFullYear(), 0, 0);
    const doy  = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - start) / 864e5;
    let dec = -23.44 * Math.cos((2 * Math.PI / 365) * (doy + 10)); // degrees
    if (Math.abs(dec) < 0.05) dec = dec < 0 ? -0.05 : 0.05;        // avoid tan(0) blowup
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    const sunLon = 180 - utcH * 15;                                 // subsolar longitude
    const decR = dec * Math.PI / 180;

    const path = new Path2D();
    const nightPoleLat = dec > 0 ? -90 : 90;   // pole opposite the sun's hemisphere
    let first = true;
    for (let lon = -180; lon <= 180; lon += 2) {
      const H = (lon - sunLon) * Math.PI / 180;
      const phi = Math.atan(-Math.cos(H) / Math.tan(decR)) * 180 / Math.PI;
      const [x, y] = project(lon, phi);
      if (first) { path.moveTo(x, y); first = false; } else path.lineTo(x, y);
    }
    // Close around the dark pole (project clamps are fine past ±90)
    const [xr, yr] = project(180, nightPoleLat);
    const [xl, yl] = project(-180, nightPoleLat);
    path.lineTo(xr, yr);
    path.lineTo(xl, yl);
    path.closePath();

    // Terminator line only (for the glow stroke)
    const line = new Path2D();
    first = true;
    for (let lon = -180; lon <= 180; lon += 2) {
      const H = (lon - sunLon) * Math.PI / 180;
      const phi = Math.atan(-Math.cos(H) / Math.tan(decR)) * 180 / Math.PI;
      const [x, y] = project(lon, phi);
      if (first) { line.moveTo(x, y); first = false; } else line.lineTo(x, y);
    }

    // Normalize subsolar lon into [-180,180] for the sun glow
    let sl = ((sunLon + 180) % 360 + 360) % 360 - 180;
    night = { path, line, sun: project(sl, dec), calcAt: Date.now() };
  }

  /* ── Frame ── */
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!night || Date.now() - night.calcAt > 60000) computeNight();

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(base, 0, 0);

    // Sun glow on the day side
    const [sx, sy] = night.sun;
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, S * 30);
    g.addColorStop(0, colors.sun);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Night shading + soft dusk edge + crisp terminator line
    ctx.fillStyle = colors.night;
    ctx.fill(night.path);
    ctx.strokeStyle = colors.dusk;
    ctx.lineWidth = S * 5;
    ctx.stroke(night.line);
    ctx.strokeStyle = colors.term;
    ctx.lineWidth = 1.2;
    ctx.stroke(night.line);

    // Travelling pulses
    if (!reduced) {
      for (const p of pulses) {
        const el = now - p.t0;
        if (el < 0) continue;
        const t = el / p.dur;
        if (t > 1) { p.t0 = now + p.wait; continue; }
        // trail
        for (let k = 4; k >= 1; k--) {
          const tt = t - k * 0.012;
          if (tt < 0) continue;
          const [tx, ty] = bezier(p, tt);
          ctx.beginPath();
          ctx.arc(tx, ty, 1.1, 0, Math.PI * 2);
          ctx.fillStyle = rgba(colors.pulse, 0.28 * (1 - k / 5));
          ctx.fill();
        }
        // head
        const [x, y] = bezier(p, t);
        ctx.beginPath();
        ctx.arc(x, y, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = colors.pulse;
        ctx.shadowColor = colors.pulse;
        ctx.shadowBlur = 7;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
  }

  /* ── Layout / lifecycle ── */
  function layout() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
    S  = Math.max(W / 360, H / 180);      // cover the viewport, crop the excess
    OX = (W - 360 * S) / 2;
    OY = (H - 180 * S) / 2;
    buildPulses();
    buildBase();
    night = null;                          // force terminator recompute at new scale
  }

  let resizeTimer;
  let redrawStill = null; // set in mount() when reduced-motion is on
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { layout(); if (redrawStill) redrawStill(); }, 150);
  }

  function mount() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = 'worldmap-bg';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText =
      'position:fixed;inset:0;z-index:-1;pointer-events:none;display:block;';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');

    readColors();
    layout();
    window.addEventListener('resize', onResize);

    // Re-skin when the palette changes (Theme.set flips data-palette on <html>)
    new MutationObserver(() => { readColors(); buildBase(); if (redrawStill) redrawStill(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-palette', 'data-theme'] });

    if (reduced) {
      // Static render, refreshed once a minute so the terminator stays honest
      const still = () => {
        computeNight();
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(base, 0, 0);
        ctx.fillStyle = colors.night;
        ctx.fill(night.path);
        ctx.strokeStyle = colors.term;
        ctx.lineWidth = 1.2;
        ctx.stroke(night.line);
      };
      redrawStill = still;
      still();
      setInterval(still, 60000);
    } else {
      raf = requestAnimationFrame(frame);
    }
  }

  return { mount };
})();

window.WorldMap = WorldMap;
