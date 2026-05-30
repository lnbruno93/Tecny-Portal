#!/usr/bin/env node
// Driver de load test. Corre los scenarios definidos en scenarios.js contra
// un backend HTTP y reporta latencia + throughput de cada uno.
//
// Uso:
//   IPRO_TARGET=https://ipro-backend-staging.up.railway.app \
//   IPRO_TOKEN=<jwt-de-un-admin> \
//   node loadtest/run.js [scenario-name]
//
// Si no se pasa scenario-name, corre todos.
// Si no se pasa IPRO_TOKEN, solo /health funciona (los otros requieren auth).
//
// Por qué no contra prod: el test genera carga sostenida durante minutos,
// puede saturar el pool de DB y degradar la experiencia de usuarios reales.
// Correr SIEMPRE contra staging.

const autocannon = require('autocannon');
const scenarios = require('./scenarios');

const TARGET = process.env.IPRO_TARGET;
const TOKEN  = process.env.IPRO_TOKEN;

if (!TARGET) {
  console.error('❌  IPRO_TARGET es requerido. Ej:');
  console.error('   IPRO_TARGET=https://ipro-backend-staging.up.railway.app');
  console.error('   Para tests local: IPRO_TARGET=http://localhost:3001');
  process.exit(1);
}

// Sanity check: si el target tiene "production" en la URL, pedir confirmación.
// Es un test SOSTENIDO, no querés disparar 50 conn/s sobre prod sin pensarlo.
if (TARGET.includes('production') && process.env.IPRO_ALLOW_PRODUCTION !== 'yes-im-sure') {
  console.error('❌  Target contiene "production". Set IPRO_ALLOW_PRODUCTION=yes-im-sure para confirmar.');
  console.error('    Recomendado: correr contra staging.');
  process.exit(1);
}

// Filtro opcional por nombre de scenario.
const requested = process.argv[2];
const toRun = requested
  ? scenarios.filter(s => s.name === requested)
  : scenarios;

if (toRun.length === 0) {
  console.error(`❌  Scenario "${requested}" no existe. Disponibles:`);
  console.error('   ' + scenarios.map(s => s.name).join(', '));
  process.exit(1);
}

const headers = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

async function runOne(scenario) {
  console.log(`\n▶  ${scenario.name}`);
  console.log(`   ${scenario.description}`);
  console.log(`   ${scenario.connections} conn × ${scenario.duration}s → ${TARGET}${scenario.path}`);

  const result = await autocannon({
    url: TARGET + scenario.path,
    connections: scenario.connections,
    duration: scenario.duration,
    headers,
    // Throughput máximo razonable — no queremos saturar el backend hasta tirar
    // timeouts puramente por carga sintética, queremos ver latencia bajo carga
    // realista.
    pipelining: 1,
    timeout: 30,
  });

  // Sanity check: si el endpoint devolvió mayoritariamente non-2xx, algo está
  // mal configurado (token expirado, path equivocado). Avisar.
  const total = result.requests.total;
  const non2xx = result.non2xx;
  const errorRate = total > 0 ? (non2xx / total) * 100 : 0;

  // Autocannon v8 expone p50, p90, p97_5, p99 (no p95). Usamos p90 + p99 como
  // headline; p97_5 está disponible si se necesita una métrica entre los dos.
  const summary = {
    name:             scenario.name,
    total_requests:   total,
    rps:              result.requests.average,
    latency_avg_ms:   result.latency.average,
    latency_p50_ms:   result.latency.p50,
    latency_p90_ms:   result.latency.p90,
    latency_p97_5_ms: result.latency.p97_5,
    latency_p99_ms:   result.latency.p99,
    latency_max_ms:   result.latency.max,
    errors:           result.errors,
    timeouts:         result.timeouts,
    non2xx,
    error_rate_pct:   Number(errorRate.toFixed(2)),
  };

  // Print resumen formato amigable.
  console.log(`   RPS: ${summary.rps.toFixed(1)} | ` +
              `p50: ${summary.latency_p50_ms}ms | ` +
              `p90: ${summary.latency_p90_ms}ms | ` +
              `p99: ${summary.latency_p99_ms}ms | ` +
              `max: ${summary.latency_max_ms}ms`);
  if (summary.error_rate_pct > 0) {
    console.log(`   ⚠  Error rate: ${summary.error_rate_pct}% (${summary.non2xx}/${summary.total_requests} non-2xx, ` +
                `${summary.errors} conn errors, ${summary.timeouts} timeouts)`);
  } else {
    console.log(`   ✓  Sin errores`);
  }

  return summary;
}

async function main() {
  console.log(`Load test contra ${TARGET}`);
  console.log(`Token: ${TOKEN ? '✓ presente' : '✗ ausente (solo /health funcionará)'}`);
  console.log(`Scenarios a correr: ${toRun.map(s => s.name).join(', ')}\n`);

  const results = [];
  for (const scenario of toRun) {
    try {
      results.push(await runOne(scenario));
    } catch (err) {
      console.error(`✘  ${scenario.name} falló: ${err.message}`);
      results.push({ name: scenario.name, error: err.message });
    }
  }

  // Tabla resumen al final.
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('RESUMEN');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('Scenario                  RPS    p50    p90    p99    err%');
  console.log('--------------------------------------------------------------');
  for (const r of results) {
    if (r.error) {
      console.log(`${r.name.padEnd(25)} ERROR: ${r.error}`);
      continue;
    }
    console.log(
      r.name.padEnd(25) +
      String(r.rps.toFixed(0)).padStart(5) + '   ' +
      String(r.latency_p50_ms).padStart(4) + 'ms ' +
      String(r.latency_p90_ms).padStart(4) + 'ms ' +
      String(r.latency_p99_ms).padStart(4) + 'ms ' +
      String(r.error_rate_pct).padStart(5) + '%'
    );
  }
  console.log('══════════════════════════════════════════════════════════════');
  console.log('Guardar estos números en docs/LOAD_BASELINE.md si es la baseline.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
