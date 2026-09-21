// HOW TO SCORE A with AI
// Vercel Serverless Function: /api/admin-reset-student-progress
// Purpose: reset one student's learning progress to Day 1 safely.
// Keeps auth account + Student ID + enrollment/course access untouched.
// Optional: clear that student's daily reflection history for a completely fresh retest.

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  "https://htzkjfztqqsbzxahxfnt.supabase.co";

const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_-2O1fEqOGCQPSiMGQVSFrQ_bC3hf4WM";

const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function send(res,status,body){res.status(status).json(body)}

async function fetchJson(url,options={}){
  const r=await fetch(url,options);
  const raw=await r.text();
  let data=null;
  try{data=raw?JSON.parse(raw):null}catch{data=raw}
  if(!r.ok){
    const msg=data?.msg||data?.message||data?.error_description||data?.error||raw||`HTTP ${r.status}`;
    const e=new Error(msg);e.status=r.status;e.data=data;throw e;
  }
  return data;
}
async function getCallerUser(token){
  return fetchJson(`${SUPABASE_URL}/auth/v1/user`,{
    headers:{apikey:SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`}
  });
}
async function callerIsAdmin(userId){
  const rows=await fetchJson(
    `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${encodeURIComponent(userId)}&role=eq.admin&select=role&limit=1`,
    {headers:{apikey:SERVICE_ROLE_KEY,Authorization:`Bearer ${SERVICE_ROLE_KEY}`}}
  );
  return Array.isArray(rows)&&rows.length>0;
}
async function serviceRest(path,options={}){
  return fetchJson(`${SUPABASE_URL}/rest/v1/${path}`,{
    ...options,
    headers:{
      apikey:SERVICE_ROLE_KEY,
      Authorization:`Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type":"application/json",
      Prefer:options.prefer||"return=representation",
      ...(options.headers||{})
    }
  });
}

module.exports=async function handler(req,res){
  if(req.method!=="POST"){
    res.setHeader("Allow","POST");
    return send(res,405,{ok:false,error:"Method not allowed"});
  }
  if(!SERVICE_ROLE_KEY){
    return send(res,500,{ok:false,error:"Server is missing SUPABASE_SERVICE_ROLE_KEY."});
  }

  const auth=req.headers.authorization||"";
  const token=auth.startsWith("Bearer ")?auth.slice(7):"";
  if(!token)return send(res,401,{ok:false,error:"Admin login token is missing."});

  try{
    const caller=await getCallerUser(token);
    if(!caller?.id)return send(res,401,{ok:false,error:"Invalid Admin session."});
    if(!(await callerIsAdmin(caller.id))){
      return send(res,403,{ok:false,error:"This account does not have the admin role."});
    }

    const body=req.body||{};
    const studentId=String(body.student_id||"").trim();
    const clearReflections=body.clear_reflections===true;

    if(!studentId)return send(res,400,{ok:false,error:"student_id is required."});

    // Accept BOTH:
    // 1) public Student ID, e.g. SCORE-A00001
    // 2) internal UUID from public.students.id
    const looksLikeUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(studentId);

    let students;
    if(looksLikeUuid){
      students=await serviceRest(
        `students?id=eq.${encodeURIComponent(studentId)}&select=id,student_id,full_name,user_id&limit=1`,
        {method:"GET"}
      );
    }else{
      students=await serviceRest(
        `students?student_id=eq.${encodeURIComponent(studentId)}&select=id,student_id,full_name,user_id&limit=1`,
        {method:"GET"}
      );
    }

    const student=students?.[0];
    if(!student)return send(res,404,{ok:false,error:"Student not found."});

    // Preserve personalization where possible, but reset learning progression.
    let current=null;
    try{
      const rows=await serviceRest(
        `scorea_student_progress?student_id=eq.${encodeURIComponent(student.id)}&select=avatar,visual_mode,language,user_state&limit=1`,
        {method:"GET"}
      );
      current=rows?.[0]||null;
    }catch(e){}

    const freshAppState={
      day:1,
      xp:0,
      done:[],
      badges:[],
      streak:1,
      focus:0,
      time:0,
      learn:0,
      logs:[],
      rewarded:{},
      avatar:current?.avatar||"explorer",
      avatarOutfit:"academy",
      avatarAccessory:"none"
    };

    const freshCycleState={
      cycle:1,
      day:1,
      read:{},
      time:{},
      ai:{},
      readThought:{},
      readCompletedAt:{},
      readDraft:{}
    };

    const now=new Date().toISOString();

    // Update existing Cloud Progress row(s).
    const updated=await serviceRest(
      `scorea_student_progress?student_id=eq.${encodeURIComponent(student.id)}`,
      {
        method:"PATCH",
        body:JSON.stringify({
          user_id:student.user_id,
          current_cycle:1,
          current_day:1,
          xp:0,
          focus:0,
          time_management:0,
          self_learning:0,
          updated_at:now,
          state_version:2,
          app_state:freshAppState,
          cycle_state:freshCycleState,
          // Preserve user/toolbox profile settings.
          user_state:current?.user_state||{},
          avatar:current?.avatar||"explorer",
          visual_mode:current?.visual_mode||"junior",
          language:current?.language||"zh",
          last_synced_at:now
        })
      }
    );

    // If no row existed, create one.
    if(!(updated||[]).length){
      await serviceRest("scorea_student_progress",{
        method:"POST",
        body:JSON.stringify({
          student_id:student.id,
          user_id:student.user_id,
          current_cycle:1,
          current_day:1,
          xp:0,
          focus:0,
          time_management:0,
          self_learning:0,
          updated_at:now,
          state_version:2,
          app_state:freshAppState,
          cycle_state:freshCycleState,
          user_state:current?.user_state||{},
          avatar:current?.avatar||"explorer",
          visual_mode:current?.visual_mode||"junior",
          language:current?.language||"zh",
          last_synced_at:now
        })
      });
    }

    let deletedReflections=false;
    if(clearReflections){
      await serviceRest(
        `scorea_daily_reflections?student_id=eq.${encodeURIComponent(student.id)}`,
        {method:"DELETE",prefer:"return=minimal"}
      );
      deletedReflections=true;
    }

    return send(res,200,{
      ok:true,
      message:"学习进度已重置到 Day 1。",
      student:{
        id:student.id,
        student_id:student.student_id,
        full_name:student.full_name
      },
      cleared_reflections:deletedReflections
    });

  }catch(err){
    console.error(err);
    return send(res,err.status||500,{ok:false,error:err.message||"Reset failed."});
  }
};
