const http = require('http');
const assert = require('assert');
const { app, start } = require('../src/index');
const { initDatabase, db } = require('../src/db');

let server;
const TEST_PORT = 8999;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { json = data; }
        resolve({ status: res.statusCode, headers: res.headers, data: json });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('\n======================================================');
  console.log('   TRUSTDESK NODE.JS / KELU LITE - TEST SUITE');
  console.log('======================================================\n');

  await initDatabase();
  await new Promise((resolve) => {
    server = app.listen(TEST_PORT, '127.0.0.1', resolve);
  });

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    -> ${err.message}`);
      failed++;
    }
  }

  // 1. Health check
  await test('GET /health returns healthy service status', async () => {
    const res = await request('GET', '/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status, 'healthy');
    assert.strictEqual(res.data.reranker, 'Jev System One (WASM-Indexed)');
  });

  // 2. Canonical /tickets and /api/tickets
  await test('GET /tickets returns seeded tickets list', async () => {
    const res = await request('GET', '/tickets');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.ok(res.data.length >= 8);
    assert.strictEqual(res.data[0].customer !== undefined, true);
  });

  // 3. Single Ticket & Linked Context
  await test('GET /api/tickets/tkt_9001 returns ticket with customer & order context', async () => {
    const res = await request('GET', '/api/tickets/tkt_9001');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ticket_id, 'tkt_9001');
    assert.ok(res.data.customer);
    assert.strictEqual(res.data.customer.customer_id, 'cus_1001');
    assert.ok(res.data.order);
    assert.strictEqual(res.data.order.order_id, 'ord_5001');
  });

  // 4. Ticket Triage
  await test('POST /api/tickets/tkt_9001/triage classifies category and priority', async () => {
    const res = await request('POST', '/api/tickets/tkt_9001/triage');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.triage);
    assert.strictEqual(res.data.triage.category, 'refund');
    assert.strictEqual(res.data.triage.priority, 'medium');
  });

  // 5. Cited Draft Generation
  await test('POST /api/tickets/tkt_9001/draft-reply includes canonical policy citations', async () => {
    const res = await request('POST', '/api/tickets/tkt_9001/draft-reply');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.draft_reply);
    assert.ok(Array.isArray(res.data.citations));
    assert.ok(res.data.citations.includes('KB-REFUND-001'));
    assert.ok(res.data.run_id.startsWith('run_'));
  });

  // 6. Ticket Resolution & Escalation
  await test('POST /api/tickets/:id/resolve and /escalate update ticket status', async () => {
    const resResolve = await request('POST', '/api/tickets/tkt_9001/resolve');
    assert.strictEqual(resResolve.status, 200);
    assert.strictEqual(resResolve.data.ticket.status, 'resolved');

    const resEscalate = await request('POST', '/api/tickets/tkt_9002/escalate', { reason: 'Customer requested supervisor' });
    assert.strictEqual(resEscalate.status, 200);
    assert.strictEqual(resEscalate.data.ticket.status, 'escalated');
  });

  // 7. Knowledge Search
  await test('GET /api/documents/search returns scored policy documents', async () => {
    const res = await request('GET', '/api/documents/search?q=damaged+earbuds');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data));
    assert.ok(res.data.length > 0);
    assert.ok(res.data[0].doc_id);
    assert.ok(res.data[0].score > 0);
  });

  // 8. Background Knowledge Sync Worker
  await test('POST /api/documents/sync-async queues background worker task', async () => {
    const res = await request('POST', '/api/documents/sync-async', {
      source_type: 'pack',
      source_name: 'Policy Refresh Pack'
    });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.data.status, 'queued');
    assert.ok(res.data.job_id.startsWith('job_sync_'));

    const listRes = await request('GET', '/api/documents/sync-jobs');
    assert.strictEqual(listRes.status, 200);
    assert.ok(Array.isArray(listRes.data));
  });

  // 9. Tool Actions Catalog & Approval Gate with Idempotency
  await test('POST /api/tool-actions enforces human approval gate and idempotency', async () => {
    const idempotencyKey = `idemp_test_${Date.now()}`;
    const payload = {
      tool_name: 'create_replacement_order',
      ticket_id: 'tkt_9001',
      order_id: 'ord_5001',
      idempotency_key: idempotencyKey,
      parameters: { sku: 'BG-AIRPODS-01' }
    };

    // 1. Initial request -> requires approval
    const res1 = await request('POST', '/api/tool-actions', payload);
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.data.status, 'pending_approval');
    assert.strictEqual(res1.data.requires_approval, true);
    const requestId = res1.data.request_id;

    // 2. Idempotent replay -> returns cached response
    const resReplay = await request('POST', '/api/tool-actions', payload);
    assert.strictEqual(resReplay.status, 200);
    assert.strictEqual(resReplay.data.request_id, requestId);
    assert.strictEqual(resReplay.data.is_idempotent_replay, true);

    // 3. Supervisor approves -> executes action
    const resApprove = await request('POST', `/api/tool-actions/${requestId}/approve`, { reviewed_by: 'jananis@atatus.com' });
    assert.strictEqual(resApprove.status, 200);
    assert.strictEqual(resApprove.data.status, 'executed');
    assert.ok(resApprove.data.execution_result.replacement_order_id);
  });

  // 10. Adversarial Guardrails
  await test('Guardrails defend against adversarial coupon and prompt injection', async () => {
    // Adversarial coupon request (tkt_9006)
    const resCoupon = await request('POST', '/api/tickets/tkt_9006/draft-reply');
    assert.strictEqual(resCoupon.status, 200);
    assert.strictEqual(resCoupon.data.guardrail_results.prompt_injection_detected, true);
    assert.ok(resCoupon.data.citations.includes('KB-COUPON-001'));

    // Adversarial secret leak request (tkt_9007)
    const resSecret = await request('POST', '/api/tickets/tkt_9007/draft-reply');
    assert.strictEqual(resSecret.status, 200);
    assert.strictEqual(resSecret.data.guardrail_results.secret_leak_prevented, true);
    assert.strictEqual(resSecret.data.recommended_action, 'escalate_to_human');
  });

  // 11. Multi-Platform Webhook Ingress
  await test('POST /api/webhooks/zendesk, intercom, freshdesk ingests and triages tickets', async () => {
    // Zendesk
    const zdRes = await request('POST', '/api/webhooks/zendesk', {
      ticket: { subject: 'Zendesk Earbuds Broken', description: 'Left earbud stopped playing sound.' }
    });
    assert.strictEqual(zdRes.status, 200);
    assert.ok(zdRes.data.ticket_id.startsWith('tkt_ze_'));

    // Intercom
    const icRes = await request('POST', '/api/webhooks/intercom', {
      title: 'Intercom Delayed Package', body: 'Where is my order?'
    });
    assert.strictEqual(icRes.status, 200);
    assert.ok(icRes.data.ticket_id.startsWith('tkt_in_'));

    // Freshdesk
    const fdRes = await request('POST', '/api/webhooks/freshdesk', {
      subject: 'Freshdesk Inquiry', description: 'Need replacement'
    });
    assert.strictEqual(fdRes.status, 200);
    assert.ok(fdRes.data.ticket_id.startsWith('tkt_fr_'));
  });

  // 12. Staff RBAC Lifecycle
  await test('Staff API: create, update role, and delete staff member', async () => {
    const createRes = await request('POST', '/api/staff', {
      name: 'Test Staff',
      email: `test.${Date.now()}@atatus.com`,
      role: 'support_agent',
      department: 'Customer Care'
    });
    assert.strictEqual(createRes.status, 201);
    const userId = createRes.data.user_id;

    const putRes = await request('PUT', `/api/staff/${userId}/role`, { role: 'support_manager' });
    assert.strictEqual(putRes.status, 200);
    assert.strictEqual(putRes.data.role, 'support_manager');

    const delRes = await request('DELETE', `/api/staff/${userId}`);
    assert.strictEqual(delRes.status, 200);
  });

  // 13. Evaluation Benchmark Suite (8/8 Cases)
  await test('POST /api/eval-runs executes evaluation benchmark with 100% accuracy', async () => {
    const res = await request('POST', '/api/eval-runs');
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.data.dataset_size, 8);
    assert.strictEqual(res.data.passed_cases, 8);
    assert.strictEqual(res.data.failed_cases, 0);
    assert.strictEqual(res.data.accuracy_percentage, '100%');
  });

  // 14. Support Form Deflector & Copilot Q&A
  await test('Support Form Deflector and Copilot answer inquiries with grounding', async () => {
    const defRes = await request('POST', '/api/deflector/evaluate', { query: 'What is the return policy for damaged items?' });
    assert.strictEqual(defRes.status, 200);
    assert.strictEqual(defRes.data.deflected, true);
    assert.ok(defRes.data.resolution.includes('KB-REFUND-001'));

    const copRes = await request('POST', '/api/copilot/ask', { question: 'Are warranty claims covered for swollen batteries?' });
    assert.strictEqual(copRes.status, 200);
    assert.ok(copRes.data.answer.includes('KB-WARRANTY-001'));
  });

  server.close();

  console.log('\n======================================================');
  console.log(`   TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  if (server) server.close();
  process.exit(1);
});
