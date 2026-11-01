/** Public core never downloads live provider data. Demo must be explicitly selected. */
export const isSyntheticDemo=()=>typeof location!=='undefined' && new URLSearchParams(location.search).get('demo')==='synthetic';
export function datasetUrl(base:string,file:string){
 if(!['player-stats.json','player-projections.json','projection-scenarios.json','analysis-schedule.json','projection-refresh-status.json','fantasy-positions.json','current-rosters.json'].includes(file))throw new Error('Unsupported dataset path');
 return `${base}${isSyntheticDemo()?'demo/':''}data/${file}`;
}
export const publicProviderFetch:typeof fetch=async(input,init)=>{
 if(!isSyntheticDemo())throw new Error('PUBLIC_CORE_LIVE_DATA_DISABLED: canlı sağlayıcı erişimi bu dağıtımda yok; sentetik demo açıkça seçilmelidir.');
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(url.origin!=='https://lm-api-reads.fantasy.espn.com'||!/^\/apis\/v3\/games\/fba\/seasons\/2027\/segments\/0\/leagues\/789$/.test(url.pathname))return new Response('{}',{status:404});
 if((init?.method??'GET')!=='GET')throw new Error('Synthetic adapter is read-only');
 const pool=url.searchParams.get('view')==='kona_player_info';
 const response=await fetch(`${import.meta.env.BASE_URL}demo/${pool?'pool':'league'}.json`,{signal:init?.signal,credentials:'omit',cache:'no-cache'});
 if(!response.ok)throw new Error('Sentetik demo girdisi eksik; canlı kaynağa fallback yok.');
 const body=await response.json();
 if(body.provenance?.kind!=='synthetic')throw new Error('Synthetic provenance required');
 if(pool){const filter=JSON.parse(new Headers(init?.headers).get('x-fantasy-filter')??'{}').players;
  if(!filter||!Number.isSafeInteger(filter.offset)||!Number.isSafeInteger(filter.limit)||filter.offset<0||filter.limit<1||filter.limit>200)throw new Error('Invalid synthetic pagination');
  const total=body.players.length;body.players=body.players.slice(filter.offset,filter.offset+filter.limit);
  return Response.json(body,{headers:{'x-fantasy-filter-player-count':String(total)}});
 }
 return Response.json(body);
};
