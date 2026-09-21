module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'Server configuration is missing.'
    });
  }

  const serviceHeaders = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  };

  async function readJson(response) {
    const text = await response.text();

    if (!text) return {};

    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }

  async function cleanupAuthUser(userId) {
    if (!userId) return;

    try {
      await fetch(
        `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
        {
          method: 'DELETE',
          headers: serviceHeaders
        }
      );
    } catch (_) {}
  }

  async function cleanupStudent(studentUuid) {
    if (!studentUuid) return;

    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/students?id=eq.${encodeURIComponent(studentUuid)}`,
        {
          method: 'DELETE',
          headers: serviceHeaders
        }
      );
    } catch (_) {}
  }

  function malaysiaToday() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());

    const values = {};

    for (const part of parts) {
      if (part.type !== 'literal') {
        values[part.type] = part.value;
      }
    }

    return `${values.year}-${values.month}-${values.day}`;
  }

  function addDays(dateString, days) {
    const [year, month, day] = dateString.split('-').map(Number);

    const date = new Date(
      Date.UTC(year, month - 1, day)
    );

    date.setUTCDate(date.getUTCDate() + days);

    return date.toISOString().slice(0, 10);
  }

  async function getNextStudentCode() {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/students?select=student_id&student_id=like.SCORE-A*&order=student_id.desc&limit=1`,
      {
        headers: serviceHeaders
      }
    );

    if (!response.ok) {
      const error = await readJson(response);
      throw new Error(
        error.message || 'Unable to generate Student ID.'
      );
    }

    const rows = await readJson(response);

    let nextNumber = 1;

    if (Array.isArray(rows) && rows.length) {
      const match = String(rows[0].student_id || '')
        .match(/^SCORE-A(\d+)$/i);

      if (match) {
        nextNumber = Number(match[1]) + 1;
      }
    }

    return `SCORE-A${String(nextNumber).padStart(5, '0')}`;
  }

  let createdAuthUserId = null;
  let createdStudentUuid = null;

  try {
    // ======================================================
    // 1. VERIFY LOGGED-IN ADMIN
    // ======================================================

    const authorization =
      req.headers.authorization ||
      req.headers.Authorization ||
      '';

    if (!authorization.startsWith('Bearer ')) {
      return res.status(401).json({
        ok: false,
        error: 'Please login as administrator first.'
      });
    }

    const adminAccessToken =
      authorization.substring(7).trim();

    const userResponse = await fetch(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${adminAccessToken}`
        }
      }
    );

    if (!userResponse.ok) {
      return res.status(401).json({
        ok: false,
        error: 'Administrator login has expired. Please login again.'
      });
    }

    const adminUser = await readJson(userResponse);

    if (!adminUser.id) {
      return res.status(401).json({
        ok: false,
        error: 'Unable to verify administrator.'
      });
    }

    const adminCheckResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/scorea_admin_users?user_id=eq.${encodeURIComponent(adminUser.id)}&is_active=eq.true&select=user_id&limit=1`,
      {
        headers: serviceHeaders
      }
    );

    if (!adminCheckResponse.ok) {
      throw new Error('Unable to verify administrator permission.');
    }

    const adminRows = await readJson(adminCheckResponse);

    if (!Array.isArray(adminRows) || !adminRows.length) {
      return res.status(403).json({
        ok: false,
        error: 'This account does not have administrator permission.'
      });
    }

    // ======================================================
    // 2. VALIDATE NEW STUDENT INFORMATION
    // ======================================================

    const body = req.body || {};

    const fullName =
      String(body.full_name || '').trim();

    const email =
      String(body.email || '').trim().toLowerCase();

    const password =
      String(body.password || '');

    const grade =
      String(body.grade || '').trim();

    const planDays =
      Number(body.plan_days);

    if (!fullName) {
      return res.status(400).json({
        ok: false,
        error: 'Please enter student name.'
      });
    }

    if (!email || !email.includes('@')) {
      return res.status(400).json({
        ok: false,
        error: 'Please enter a valid Email.'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        ok: false,
        error: 'Temporary password must contain at least 8 characters.'
      });
    }

    if (!grade) {
      return res.status(400).json({
        ok: false,
        error: 'Please enter student grade.'
      });
    }

    if (![365, 730].includes(planDays)) {
      return res.status(400).json({
        ok: false,
        error: 'Plan must be 365 or 730 days.'
      });
    }

    // ======================================================
    // 3. FIND ACTIVE SCORE-A COURSE
    // ======================================================

    const courseResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/courses?course_code=eq.SCORE-A&is_active=eq.true&select=id,course_code&limit=1`,
      {
        headers: serviceHeaders
      }
    );

    if (!courseResponse.ok) {
      const error = await readJson(courseResponse);

      throw new Error(
        error.message || 'Unable to find SCORE-A course.'
      );
    }

    const courseRows = await readJson(courseResponse);

    if (!Array.isArray(courseRows) || !courseRows.length) {
      throw new Error('Active SCORE-A course was not found.');
    }

    const courseId = courseRows[0].id;

    // ======================================================
    // 4. CREATE SUPABASE AUTH LOGIN
    // ======================================================

    const authResponse = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users`,
      {
        method: 'POST',
        headers: serviceHeaders,
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: {
            full_name: fullName,
            grade,
            account_type: 'student'
          }
        })
      }
    );

    const authResult = await readJson(authResponse);

    if (!authResponse.ok) {
      return res.status(400).json({
        ok: false,
        error:
          authResult.msg ||
          authResult.message ||
          authResult.error_description ||
          'Unable to create student login account.'
      });
    }

    const authUser =
      authResult.user || authResult;

    if (!authUser.id) {
      throw new Error(
        'Student login was created but User ID could not be obtained.'
      );
    }

    createdAuthUserId = authUser.id;

    // ======================================================
    // 5. CREATE STUDENT PROFILE
    // ======================================================

    let studentRow = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const studentCode =
        await getNextStudentCode();

      const studentResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/students?select=id,student_id,full_name,grade,status,user_id`,
        {
          method: 'POST',
          headers: {
            ...serviceHeaders,
            Prefer: 'return=representation'
          },
          body: JSON.stringify({
            student_id: studentCode,
            user_id: createdAuthUserId,
            full_name: fullName,
            grade,
            status: 'ACTIVE'
          })
        }
      );

      const studentResult =
        await readJson(studentResponse);

      if (studentResponse.ok) {
        studentRow =
          Array.isArray(studentResult)
            ? studentResult[0]
            : studentResult;

        break;
      }

      const duplicate =
        studentResult.code === '23505';

      if (!duplicate) {
        throw new Error(
          studentResult.message ||
          'Unable to create student profile.'
        );
      }
    }

    if (!studentRow || !studentRow.id) {
      throw new Error(
        'Unable to generate a unique Student ID.'
      );
    }

    createdStudentUuid = studentRow.id;

    // ======================================================
    // 6. CREATE 365 / 730 DAY ENROLLMENT
    // ======================================================

    const startDate =
      malaysiaToday();

    const expiryDate =
      addDays(startDate, planDays);

    const enrollmentResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/enrollments?select=id,student_id,course_id,plan_days,start_date,expiry_date,status`,
      {
        method: 'POST',
        headers: {
          ...serviceHeaders,
          Prefer: 'return=representation'
        },
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

    const enrollmentResult =
      await readJson(enrollmentResponse);

    if (!enrollmentResponse.ok) {
      throw new Error(
        enrollmentResult.message ||
        'Unable to create course enrollment.'
      );
    }

    const enrollmentRow =
      Array.isArray(enrollmentResult)
        ? enrollmentResult[0]
        : enrollmentResult;

    // ======================================================
    // 7. WRITE AUDIT LOG
    // ======================================================

    await fetch(
      `${SUPABASE_URL}/rest/v1/scorea_enrollment_access_log`,
      {
        method: 'POST',
        headers: serviceHeaders,
        body: JSON.stringify({
          enrollment_id: enrollmentRow.id,
          student_id: createdStudentUuid,
          action:
            planDays === 730
              ? 'ACTIVATE_730'
              : 'ACTIVATE_365',
          days_added: planDays,
          old_expiry_date: null,
          new_expiry_date: expiryDate,
          admin_user_id: adminUser.id
        })
      }
    );

    // ======================================================
    // SUCCESS
    // ======================================================

    return res.status(200).json({
      ok: true,
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
    // If part of the process failed, remove unfinished records
    if (createdStudentUuid) {
      await cleanupStudent(createdStudentUuid);
    }

    if (createdAuthUserId) {
      await cleanupAuthUser(createdAuthUserId);
    }

    return res.status(500).json({
      ok: false,
      error:
        error && error.message
          ? error.message
          : 'Unable to create student.'
    });
  }
};
