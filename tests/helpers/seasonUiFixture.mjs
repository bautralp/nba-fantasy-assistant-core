/** Hand-authored UI data, never copied from a live league. */
export function seasonUiFixture() {
 const categories = [19, 20, 17, 6, 3, 2, 1, 11, 0];
 const records = [{wins:2,losses:0,ties:0}, {wins:1,losses:0,ties:1}, {wins:2,losses:2,ties:0}, {wins:1,losses:1,ties:0}, {wins:0,losses:1,ties:0}, {wins:0,losses:0,ties:0}, null, {wins:1,losses:null,ties:0}, {wins:1,losses:2,ties:0}, {wins:0,losses:0,ties:0}];
 const teams = Array.from({length:10}, (_,i) => {
  const id = i+1;
  const player = (offset,name,defaultPositionId,eligibleSlots) => ({playerId:id*100+offset,lineupSlotId:11,playerPoolEntry:{player:{id:id*100+offset,fullName:`T${id} ${name}`,defaultPositionId,eligibleSlots}}});
  return {id,name:id===4?'Örnek Anadolu Yıldızları Uzun Takım Adı Tamamen Okunabilmeli':'Örnek Takım '+id,rankCalculatedFinal:id,playoffSeed:11-id,currentProjectedRank:id,record:records[i] ? {overall:{...records[i],gamesBack:i/2}} : undefined,roster:{entries:[
   player(1,'Center',5,[4,9,10,11,12,13]),player(2,'Unknown',999,[5,6,7,8,11,12]),player(3,'Forward',3,[2,3,6,11]),
   player(4,'Multi',5,[0,1,4,5,9,11]),player(5,'Guard',1,[0,1,5,11]),player(6,'Power',4,[3,6,9,11]),
  ]}};
 });
 const values = [{19:.45,20:.8,17:10,6:25,3:50,2:7,1:4,11:5,0:100},{19:.5,20:.75,17:9,6:24,3:40,2:5,1:4,11:9,0:90}];
 const side = (id,index,future) => ({teamId:id,totalPoints:0,cumulativeScore:future?{wins:0,losses:0,ties:0,scoreByStat:null}:{wins:index?1:7,losses:index?7:1,ties:1,scoreByStat:Object.fromEntries(Object.entries(values[index]).map(([k,score])=>[k,{score}]))}});
 const pairs = {2:[[1,2],[3,4],[5,6],[7,8],[9,10]],4:[[1,3],[2,5],[6,4],[7,9],[8,10]],7:[[1,4],[2,3],[5,6],[7,8],[9,10]]};
 return {id:789,seasonId:2027,scoringPeriodId:23,status:{currentMatchupPeriod:4},settings:{name:'Synthetic compact league',isPublic:true,scoringSettings:{scoringType:'H2H_MOST_CATEGORIES',scoringItems:categories.map(statId=>({statId,points:1,isReverseItem:statId===11}))},rosterSettings:{lineupSlotCounts:{0:1,1:1,2:1,3:1,4:1,11:3,12:3,13:2}}},teams,schedule:Object.entries(pairs).flatMap(([week,pairs])=>pairs.map(([home,away])=>({matchupPeriodId:Number(week),home:side(home,0,Number(week)>4),away:side(away,1,Number(week)>4)})))};
}
