
const {onCall,HttpsError}=require("firebase-functions/v2/https");
const {defineSecret}=require("firebase-functions/params");
const admin=require("firebase-admin");

admin.initializeApp();

const APIFY_TOKEN=defineSecret("APIFY_TOKEN");
const REGION="southamerica-east1";
const ACTOR="compass~crawler-google-places";

async function authorized(request){
  if(!request.auth){
    throw new HttpsError("unauthenticated","Faça login primeiro.");
  }
  const uid=request.auth.uid;
  const snap=await admin.firestore().doc(`admins/${uid}`).get();
  if(!snap.exists){
    throw new HttpsError("permission-denied","Acesso não autorizado.");
  }
  return uid;
}

async function apify(path,options={}){
  const response=await fetch("https://api.apify.com/v2/"+path,{
    ...options,
    headers:{
      "Authorization":"Bearer "+APIFY_TOKEN.value(),
      "Content-Type":"application/json",
      ...(options.headers||{})
    }
  });
  if(!response.ok){
    const body=await response.text();
    console.error("Apify error",response.status,body.slice(0,500));
    throw new HttpsError("unavailable",
      "Falha na consulta à Apify. Verifique saldo, Actor e configuração.");
  }
  return response.json();
}

exports.startSearch=onCall({
  region:REGION,
  secrets:[APIFY_TOKEN],
  maxInstances:2,
  enforceAppCheck:false
},async request=>{
  const uid=await authorized(request);
  const {city,state,segment,limit}=request.data||{};

  const cities=String(city||"").trim();
  const states=["SP","MG","RJ","PR","SC","RS","ES","GO",
    "BA","DF","MS","MT"];
  const segments=[
    "Barbearias","Oficinas mecânicas","Salões de beleza",
    "Eletricistas","Encanadores","Lojas de roupas",
    "Clínicas de estética","Pet shops","Restaurantes","Confeitarias"
  ];

  if(!/^[\p{L}\s.'-]{2,80}$/u.test(cities)||
     !states.includes(state)||
     !segments.includes(segment)||
     ![10,20,50].includes(limit)){
    throw new HttpsError("invalid-argument","Filtros inválidos.");
  }

  const db=admin.firestore();
  const recent=await db.collection("searchRuns")
    .where("uid","==",uid)
    .orderBy("createdAt","desc")
    .limit(1).get();

  if(!recent.empty){
    const last=recent.docs[0].data();
    const elapsed=Date.now()-last.createdAt.toMillis();
    if(elapsed<60000){
      throw new HttpsError("resource-exhausted",
        "Aguarde um minuto antes de iniciar outra pesquisa.");
    }
  }

  const input={
    searchStringsArray:[segment],
    locationQuery:`${cities}, ${state}, Brasil`,
    maxCrawledPlacesPerSearch:limit,
    language:"pt-BR",
    countryCode:"br",
    scrapePlaceDetailPage:false
  };

  const run=await apify(`acts/${ACTOR}/runs`,{
    method:"POST",
    body:JSON.stringify(input)
  });

  const runId=run.data?.id;
  if(!runId)throw new HttpsError("internal","Execução não iniciada.");

  await db.collection("searchRuns").doc(runId).set({
    uid,createdAt:admin.firestore.FieldValue.serverTimestamp(),
    city:cities,state,segment,limit
  });

  return {runId};
});

exports.checkSearch=onCall({
  region:REGION,
  secrets:[APIFY_TOKEN],
  maxInstances:3,
  enforceAppCheck:false
},async request=>{
  const uid=await authorized(request);
  const runId=String(request.data?.runId||"");

  if(!/^[a-zA-Z0-9]{10,40}$/.test(runId)){
    throw new HttpsError("invalid-argument","Identificador inválido.");
  }

  const record=await admin.firestore()
    .collection("searchRuns").doc(runId).get();

  if(!record.exists||record.data().uid!==uid){
    throw new HttpsError("permission-denied","Pesquisa não autorizada.");
  }

  const run=await apify(`actor-runs/${runId}`);
  const status=run.data?.status||"UNKNOWN";

  if(status!=="SUCCEEDED")return {status,items:[]};

  const datasetId=run.data?.defaultDatasetId;
  if(!datasetId){
    throw new HttpsError("internal","Dataset indisponível.");
  }

  const max=record.data().limit;
  const raw=await apify(
    `datasets/${datasetId}/items?clean=true&limit=${max}`
  );

  const items=(Array.isArray(raw)?raw:[]).map((p,index)=>{
    const placeId=String(
      p.placeId||p.cid||p.googleMapsUrl||
      `${runId}-${index}`
    );
    return {
      placeId,
      name:String(p.title||p.name||"Empresa sem nome"),
      phone:String(p.phone||p.phoneUnformatted||""),
      address:String(p.address||""),
      website:String(p.website||"")
    };
  });

  return {status,items};
});
