const VERSION = 'scorea-create-student-v4-20260921';

module.exports = async function handler(req, res) {
  const reply = (status, payload) => res.status(status).json({ version: VERSION, ...payload });

  if (req.method !== 'POST') {
    return reply(405, { ok: false, error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  const SERVER_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!PUBLISHABLE_KEY) missing.push('SUPABASE_PUBLISHABLE_KEY');
  if (!SERVER_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY');
  if (missing.length) {
    return reply(500, { ok: false, error: `Missing server environment variable(s): ${missing.join(', ')}` });
  }

  const serverHeaders = {
    apikey: SERVER_KEY,
    'Content-Type': 'application/json'
  };
  // Legacy service_role keys are JWTs and may be sent as Bearer.
  // New sb_secret_* keys must stay in the apikey header only.
  if (String(SERVER_KEY).startsWith('eyJ')) {
    serverHeaders.Authorization = `Bearer ${SERVER_KEY}`;
  }

  async function readJson(response) {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { return { message: text }; }
  }

  function errText(obj, fallback) {
    return obj?.message || obj?.msg || obj?.error_description || obj?.error || fallback;
  }

  function malaysiaToday() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const o = {};
    for (const p of parts) if (p.type !== 'literal') o[p.type] = p.value;
    return `${o.year}-${o.month}-${o.day}`;
  }

  function addDays(dateString, days) {
    const [y, m, d] = dateString.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  async function cleanupAuthUser(userId) {
    if (!userId) return;
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        method: 'DELETE', headers: serverHeaders
      });
    } catch (_) {}
  }

  async function cleanupStudent(studentUuid) {
    if (!studentUuid) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/students?id=eq.${encodeURIComponent(studentUuid)}`, {
        method: 'DELETE', headers: serverHeaders
      });
    } catch (_) {}
  }

  async function getNextStudentCode() {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/students?select=student_id&student_id=like.SCORE-A*&order=student_id.desc&limit=1`,
      { headers: serverHeaders }
    );
    const j = await readJson(r);
    if (!r.ok) throw new Error(`Student ID lookup failed (${r.status}): ${errText(j, 'Unknown error')}`);
    let n = 1;
    if (Array.isArray(j) && j.length) {
      const m = String(j[0].student_id || '').match(/^SCORE-A(\d+)$/i);
      if (m) n = Number(m[1]) + 1;
    }
    return `SCORE-A${String(n).padStart(5, '0')}`;
  }

  let createdAuthUserId = null;
  let createdStudentUuid = null;

  try {
    // STEP 1: verify the signed-in admin using the SAME RPC used by the working admin page.
    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) {
      return reply(401, { ok: false, step: 'admin-token', error: 'Administrator session token was not received. Please sign out and sign in again.' });
    }
    const userJwt = authorization.slice(7).trim();
    const userHeaders = {
      apikey: PUBLISHABLE_KEY,
      Authorization: `Bearer ${userJwt}`,
      'Content-Type': 'application/json'
    };

    const check = await fetch(`${SUPABASE_URL}/rest/v1/rpc/scorea_is_admin`, {
      method: 'POST', headers: userHeaders, body: '{}'
    });
    const allowed = await readJson(check);
    if (!check.ok) {
      return reply(500, {
        ok: false,
        step: 'admin-rpc',
        error: `Admin RPC failed (${check.status}): ${errText(allowed, 'Unknown RPC error')}`
      });
    }
    if (allowed !== true) {
      return reply(403, { ok: false, step: 'admin-rpc', error: 'This signed-in account is not an active Score A administrator.' });
    }

    // Get authenticated admin user id for the audit log.
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: userHeaders });
    const adminUser = await readJson(ur);
    if (!ur.ok || !adminUser?.id) {
      return reply(401, { ok: false, step: 'admin-user', error: `Unable to read administrator session (${ur.status}). Please sign in again.` });
    }

    // STEP 2: validate input.
    const body = req.body || {};
    const fullName = String(body.full_name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const grade = String(body.grade || '').trim();
    const planDays = Number(body.plan_days);

    if (!fullName) return reply(400, { ok: false, step: 'validate', error: 'Please enter student name.' });
    if (!email || !email.includes('@')) return reply(400, { ok: false, step: 'validate', error: 'Please enter a valid Email.' });
    if (password.length < 8) return reply(400, { ok: false, step: 'validate', error: 'Temporary password must contain at least 8 characters.' });
    if (!grade) return reply(400, { ok: false, step: 'validate', error: 'Please enter student grade.' });
    if (![365, 730].includes(planDays)) return reply(400, { ok: false, step: 'validate', error: 'Plan must be 365 or 730 days.' });

    // STEP 3: locate active SCORE-A course using server key.
    const cr = await fetch(
      `${SUPABASE_URL}/rest/v1/courses?course_code=eq.SCORE-A&is_active=eq.true&select=id,course_code&limit=1`,
      { headers: serverHeaders }
    );
    const courses = await readJson(cr);
    if (!cr.ok) throw new Error(`Course lookup failed (${cr.status}): ${errText(courses, 'Unknown error')}`);
    if (!Array.isArray(courses) || !courses.length) throw new Error('Active SCORE-A course was not found.');
    const courseId = courses[0].id;

    // STEP 4: create Auth user.
    const ar = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: serverHeaders,
      body: JSON.stringify({
        email, password, email_confirm: true,
        user_metadata: { full_name: fullName, grade, account_type: 'student' }
      })
    });
    const authResult = await readJson(ar);
    if (!ar.ok) {
      return reply(400, { ok: false, step: 'create-auth-user', error: `Auth user creation failed (${ar.status}): ${errText(authResult, 'Unknown error')}` });
    }
    const authUser = authResult.user || authResult;
    if (!authUser?.id) throw new Error('Student login was created but User ID could not be obtained.');
    createdAuthUserId = authUser.id;

    // STEP 5: create student row.
    let studentRow = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const studentCode = await getNextStudentCode();
      const sr = await fetch(
        `${SUPABASE_URL}/rest/v1/students?select=id,student_id,full_name,grade,status,user_id`,
        {
          method: 'POST',
          headers: { ...serverHeaders, Prefer: 'return=representation' },
          body: JSON.stringify({
            student_id: studentCode,
            user_id: createdAuthUserId,
            full_name: fullName,
            grade,
            status: 'ACTIVE'
          })
        }
      );
      const sj = await readJson(sr);
      if (sr.ok) {
        studentRow = Array.isArray(sj) ? sj[0] : sj;
        break;
      }
      if (sj?.code !== '23505') throw new Error(`Student profile creation failed (${sr.status}): ${errText(sj, 'Unknown error')}`);
    }
    if (!studentRow?.id) throw new Error('Unable to generate a unique Student ID.');
    createdStudentUuid = studentRow.id;

    // STEP 6: create enrollment.
    const startDate = malaysiaToday();
    const expiryDate = addDays(startDate, planDays);
    const er = await fetch(
      `${SUPABASE_URL}/rest/v1/enrollments?select=id,student_id,course_id,plan_days,start_date,expiry_date,status`,
      {
        method: 'POST',
        headers: { ...serverHeaders, Prefer: 'return=representation' },
        body: JSON.stringify({
          student_id: createdStudentUuid,
          course_id: courseId,
          plan_days: planDays,
          start_date: startDate,
          expiry_date: expiryDate,
          status: 'ACTIVE'
        })
      }
    );
    const ej = await readJson(er);
    if (!er.ok) throw new Error(`Enrollment creation failed (${er.status}): ${errText(ej, 'Unknown error')}`);
    const enrollmentRow = Array.isArray(ej) ? ej[0] : ej;

    // STEP 7: audit log. A log failure should not undo a valid student account.
    let auditWarning = null;
    try {
      const lr = await fetch(`${SUPABASE_URL}/rest/v1/scorea_enrollment_access_log`, {
        method: 'POST',
        headers: serverHeaders,
        body: JSON.stringify({
          enrollment_id: enrollmentRow.id,
          student_id: createdStudentUuid,
          action: planDays === 730 ? 'ACTIVATE_730' : 'ACTIVATE_365',
          days_added: planDays,
          old_expiry_date: null,
          new_expiry_date: expiryDate,
          admin_user_id: adminUser.id
        })
      });
      if (!lr.ok) {
        const lj = await readJson(lr);
        auditWarning = `Audit log failed (${lr.status}): ${errText(lj, 'Unknown error')}`;
      }
    } catch (e) {
      auditWarning = `Audit log failed: ${e.message || e}`;
    }

    return reply(200, {
      ok: true,
      warning: auditWarning,
      student: {
        id: createdStudentUuid,
        student_id: studentRow.student_id,
        full_name: fullName,
        email,
        grade,
        plan_days: planDays,
        start_date: startDate,
        expiry_date: expiryDate,
        status: 'ACTIVE'
      }
    });

  } catch (error) {
    if (createdStudentUuid) await cleanupStudent(createdStudentUuid);
    if (createdAuthUserId) await cleanupAuthUser(createdAuthUserId);
    return reply(500, {
      ok: false,
      step: 'server',
      error: error?.message || 'Unable to create student.'
    });
  }
};
