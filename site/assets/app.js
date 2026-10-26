/* Arclayer — shared chrome, i18n, motion. Vanilla, no deps. */
(function(){
"use strict";

/* ---------- i18n dictionary (EN lives in the HTML; RU here) ---------- */
const RU = {
  "nav.network":"Сеть","nav.build":"Разработчикам","nav.company":"Компания",
  "cta.launch":"Открыть приложение","cta.explore":"Изучить сеть","cta.thesis":"Концепция",
  "cta.app":"Запустить приложение","cta.team":"Связаться с командой","cta.docs":"Документация","cta.start":"Начать",
  "foot.tag":"Расчётный и исполнительный слой для институционального ончейн-финанса.",
  "foot.network":"Сеть","foot.build":"Разработчикам","foot.company":"Компания",
  "foot.validators":"Валидаторы","foot.settlement":"Расчёты","foot.custody":"Хранение","foot.status":"Статус",
  "foot.docs":"Документация","foot.sdk":"SDK","foot.api":"API","foot.grants":"Гранты",
  "foot.about":"О нас","foot.research":"Исследования","foot.careers":"Вакансии","foot.contact":"Контакты",
  "foot.rights":"© 2026 Arclayer Labs","foot.legal":"Условия · Приватность · Раскрытие",

  "marq.with":"Расчёты через",
  "hero.badge":"Приватная сеть. Публичные расчёты.",
  "hero.title":"Стратегическая инфраструктура<br><span class=\"mut\">для открытой экономики.</span>",
  "hero.lead":"Arclayer объединяет доступ к капиталу, расчётные рельсы и исполнение в один слой институционального уровня — чтобы фонды, разработчики и операторы двигались вместе.",
  "num.tag":"Arclayer в цифрах",
  "num.title":"Ликвидность, которая растёт.<br><span class=\"mut\">Измеряется ончейн, каждый блок.</span>",
  "num.settled":"<b>Всего рассчитано</b> через рельсы Arclayer с момента запуска.",
  "num.wallets":"Активных ончейн-кошельков","num.tx":"Расчётных переводов в сутки",
  "num.final":"Медианная финальность","num.uptime":"Аптайм валидаторов, 12 мес",
  "net.tag":"Сеть","net.title":"Полный стек по дизайну.<br><span class=\"mut\">Один слой, все рельсы.</span>",
  "net.sub":"Капитал, расчёты и исполнение обычно живут в разных силосах. Arclayer сводит их в одну проверяемую сеть, и ценность движется без передач между системами.",
  "f.settle.h":"Детерминированный расчёт","f.settle.p":"Меньше секунды, финально и проверяемо. Каждый перевод несёт своё доказательство, поэтому контрагенты сверяются в реальном времени, а не в конце дня.",
  "f.custody.h":"Нативное хранение","f.custody.p":"Институциональные ключи, политики доступа, без риска мостов.",
  "f.flow.h":"Прозрачный поток","f.flow.p":"Любая позиция и маршрут читаются ончейн.",
  "f.global.h":"Глобально по умолчанию","f.global.p":"Один адрес, расчёт где угодно. Операторы подключают локальные рельсы, а сеть хранит единый источник правды по всем регионам.",
  "b.tag":"Разработка на Arclayer","b.title":"Запустите рынок в три шага.<br><span class=\"mut\">Обычно команды выходят за день.</span>",
  "b.s1.h":"Подключите капитал","b.s1.p":"Откройте расчётный счёт и подайте ликвидность от фондов или собственного казначейства через единый API.",
  "b.s2.h":"Разверните исполнение","b.s2.p":"С помощью SDK публикуйте инструменты — спот, деривативы или кастомные — с политиками и риском внутри.",
  "b.s3.h":"Выходите в прод","b.s3.p":"Рассчитывайтесь на любой поддержанный рельс и сверяйтесь в реальном времени. Без батчей в конце дня и отдела сверки.",
  "cta2.title":"Почувствуйте силу<br><span class=\"mut\">единого слоя.</span>",
  "cta2.sub":"Присоединяйтесь к операторам, фондам и разработчикам, уже работающим на Arclayer.",

  /* network page */
  "np.crumb":"Сеть","np.title":"Расчётный слой,<br><span class=\"mut\">построенный на доказательствах.</span>",
  "np.lead":"Arclayer — это сеть валидаторов, которая финализирует переводы меньше чем за секунду и отдаёт доказательство по каждому из них. Ниже — как устроена архитектура.",
  "np.a.h":"Консенсус","np.a.p":"BFT-консенсус с ротацией лидера. Финальность достигается в одном раунде, форков по дизайну нет.",
  "np.b.h":"Доказуемый расчёт","np.b.p":"Каждый блок несёт агрегированное доказательство. Контрагент проверяет перевод, не доверяя оператору.",
  "np.c.h":"Хранение","np.c.p":"Ключи под политиками: лимиты, мультиподпись, гео-ограничения. Приватные ключи не покидают анклав.",
  "np.d.h":"Рельсы","np.d.p":"Исходящие расчёты в локальные платёжные системы без мостов — через нативных операторов.",
  "np.specs":"Характеристики сети",
  "np.r1k":"Финальность","np.r1v":"Медиана 0,4 с, 99-й перцентиль 0,9 с. Один раунд, без вероятностного подтверждения.",
  "np.r2k":"Пропускная способность","np.r2v":"До 14 000 расчётов в секунду на текущем наборе валидаторов, с горизонтальным ростом по шардам.",
  "np.r3k":"Валидаторы","np.r3v":"118 независимых операторов в 24 юрисдикциях. Порог — две трети для финализации.",
  "np.r4k":"Доказательства","np.r4v":"Агрегированные подписи на блок; размер доказательства постоянный независимо от числа переводов.",

  /* build page */
  "bp.crumb":"Разработчикам","bp.title":"Соберите рынок<br><span class=\"mut\">за один день.</span>",
  "bp.lead":"Единый API для капитала, SDK для исполнения и расчёт на любой рельс. Ниже — минимальный путь от ключа до первого перевода.",
  "bp.quick":"Быстрый старт","bp.code.c1":"// установить SDK и открыть расчётный счёт","bp.code.c2":"// опубликовать инструмент и рассчитать первый перевод",
  "bp.plans":"Тарифы",
  "bp.p1.h":"Песочница","bp.p1.sub":"/ месяц","bp.p1.l1":"Тестовая сеть без лимитов","bp.p1.l2":"До 3 инструментов","bp.p1.l3":"Комьюнити-поддержка","bp.p1.cta":"Начать",
  "bp.p2.h":"Про","bp.p2.sub":"/ месяц","bp.p2.l1":"Доступ к мейннету","bp.p2.l2":"Безлимит инструментов","bp.p2.l3":"Расчёт на все рельсы","bp.p2.l4":"Приоритетная поддержка","bp.p2.cta":"14 дней бесплатно",
  "bp.p3.h":"Институциям","bp.p3.sub":"по договору","bp.p3.l1":"Выделенные валидаторы","bp.p3.l2":"Кастомные политики хранения","bp.p3.l3":"SLA и аудит","bp.p3.cta":"Связаться",

  /* company page */
  "cp.crumb":"Компания","cp.title":"Инфраструктура —<br><span class=\"mut\">это доверие в коде.</span>",
  "cp.lead":"Arclayer Labs строит нейтральный расчётный слой для ончейн-финанса. Мы верим, что рынки работают лучше, когда расчёт проверяем, а не обещан.",
  "cp.mission.h":"Миссия","cp.mission.p":"Сделать расчёт институционального уровня открытым примитивом, а не закрытой привилегией нескольких посредников.",
  "cp.values.h":"Принципы","cp.values.p":"Проверяемость важнее доверия. Нейтральность важнее захвата. Простота важнее лишней гибкости.",
  "cp.team":"Команда",
  "cp.m1r":"Расчётный движок","cp.m2r":"Протокол","cp.m3r":"Хранение","cp.m4r":"Партнёрства",
  "cp.m5r":"Исследования","cp.m6r":"Безопасность","cp.m7r":"Операторы","cp.m8r":"Дизайн",

  /* 404 */
  "nf.title":"Страница не найдена","nf.p":"Такой страницы нет или её перенесли. Вернитесь на главную и начните заново.","nf.cta":"На главную"
};

/* ---------- chrome (header + footer) ---------- */
const PAGE = (location.pathname.split("/").pop()||"index.html").replace(/^$/,"index.html");
function nl(href,key,en){const on=(href===PAGE)?" class=\"on\"":"";return `<a href="${href}"${on} data-i18n="${key}">${en}</a>`;}
const HEADER = `<div class="wrap"><nav id="nav">
  <a href="index.html" class="logo"><span class="mark"></span>Arclayer</a>
  <div class="navlinks">
    ${nl("network.html","nav.network","Network")}
    ${nl("build.html","nav.build","Build")}
    ${nl("company.html","nav.company","Company")}
  </div>
  <div class="navcta">
    <div class="lang"><button data-lang="en">EN</button><button data-lang="ru">RU</button></div>
    <a href="index.html" class="btn sm"><span class="t" data-i18n="cta.launch">Launch app</span><span class="sq"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2.4"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></a>
    <button class="burger" aria-label="Menu"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
  </div>
</nav></div>`;
const FOOTER = `<div class="wrap"><div class="fgrid">
  <div class="fcol about"><a href="index.html" class="logo" style="margin-bottom:14px"><span class="mark"></span>Arclayer</a>
    <p style="color:var(--muted);font-size:.9rem;line-height:1.6" data-i18n="foot.tag">A settlement and execution layer for institutional-grade onchain finance.</p></div>
  <div class="fcol"><h4 data-i18n="foot.network">Network</h4>
    <a href="network.html" data-i18n="foot.validators">Validators</a><a href="network.html" data-i18n="foot.settlement">Settlement</a><a href="network.html" data-i18n="foot.custody">Custody</a><a href="network.html" data-i18n="foot.status">Status</a></div>
  <div class="fcol"><h4 data-i18n="foot.build">Build</h4>
    <a href="build.html" data-i18n="foot.docs">Documentation</a><a href="build.html" data-i18n="foot.sdk">SDK</a><a href="build.html" data-i18n="foot.api">API reference</a><a href="build.html" data-i18n="foot.grants">Grants</a></div>
  <div class="fcol"><h4 data-i18n="foot.company">Company</h4>
    <a href="company.html" data-i18n="foot.about">About</a><a href="company.html" data-i18n="foot.research">Research</a><a href="company.html" data-i18n="foot.careers">Careers</a><a href="company.html" data-i18n="foot.contact">Contact</a></div>
</div>
<div class="fbot"><span data-i18n="foot.rights">© 2026 Arclayer Labs</span><span data-i18n="foot.legal">Terms · Privacy · Disclosures</span></div></div>`;

const hh=document.getElementById("site-header"); if(hh)hh.innerHTML=HEADER;
const ff=document.getElementById("site-footer"); if(ff)ff.innerHTML=FOOTER;

/* ---------- i18n apply ---------- */
const orig=new WeakMap();
function applyLang(lang){
  document.documentElement.lang=lang;
  document.querySelectorAll("[data-i18n]").forEach(el=>{
    if(!orig.has(el)) orig.set(el, el.innerHTML);
    const key=el.getAttribute("data-i18n");
    const val = lang==="ru" ? RU[key] : orig.get(el);
    if(val==null) return;
    el.innerHTML = val;
  });
  document.querySelectorAll(".lang button").forEach(b=>b.classList.toggle("on",b.dataset.lang===lang));
  try{localStorage.setItem("arc_lang",lang);}catch(e){}
}
document.querySelectorAll(".lang button").forEach(b=>b.addEventListener("click",()=>applyLang(b.dataset.lang)));
let saved="en"; try{saved=localStorage.getItem("arc_lang")||"en";}catch(e){}
applyLang(saved);

/* ---------- burger ---------- */
const nav=document.getElementById("nav"), burger=document.querySelector(".burger");
if(burger)burger.addEventListener("click",()=>nav.classList.toggle("open"));

/* ---------- dot globe ---------- */
(function(){
  const cv=document.getElementById("globe"); if(!cv)return;
  const ctx=cv.getContext("2d"),W=cv.width,H=cv.height,cx=W/2,cy=H/2,R=W*0.37;
  const N=2600,pts=[],ga=Math.PI*(3-Math.sqrt(5));
  const hash=(x,y,z)=>{let h=Math.sin(x*12.98+y*78.23+z*37.71)*43758.5;return h-Math.floor(h);};
  function land(x,y,z){let v=0,a=.6,f=1.4;for(let i=0;i<4;i++){v+=a*hash(Math.round(x*f*6),Math.round(y*f*6),Math.round(z*f*6));a*=.55;f*=1.9;}return v;}
  for(let i=0;i<N;i++){const y=1-(i/(N-1))*2,r=Math.sqrt(1-y*y),th=ga*i;pts.push({x:Math.cos(th)*r,y,z:Math.sin(th)*r,l:land(Math.cos(th)*r,y,Math.sin(th)*r)});}
  let rot=0;
  (function frame(){
    ctx.clearRect(0,0,W,H);rot+=.0023;const cs=Math.cos(rot),sn=Math.sin(rot);
    for(const p of pts){const x=p.x*cs-p.z*sn,z=p.x*sn+p.z*cs,y=p.y;
      const depth=(z+1)/2,isLand=p.l>.72;
      if(!isLand&&depth<.5)continue;
      const alpha=(isLand?.95:.28)*(.25+depth*.85),size=(isLand?3.4:2.3)*(.5+depth*.8);
      ctx.beginPath();ctx.fillStyle=isLand?`rgba(200,224,255,${alpha})`:`rgba(90,140,235,${alpha*.7})`;ctx.arc(cx+x*R,cy+y*R,size,0,6.283);ctx.fill();}
    requestAnimationFrame(frame);
  })();
})();

/* ---------- mini node graph ---------- */
(function(){
  const cv=document.getElementById("mini"); if(!cv)return;
  const ctx=cv.getContext("2d"),W=cv.width,H=cv.height,nodes=[];
  for(let i=0;i<7;i++)nodes.push({x:30+Math.random()*(W-60),y:20+Math.random()*(H-40),p:Math.random()*6.28});
  (function f(t){
    ctx.clearRect(0,0,W,H);ctx.strokeStyle="rgba(120,165,255,.25)";ctx.lineWidth=1;
    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){const d=Math.hypot(nodes[i].x-nodes[j].x,nodes[i].y-nodes[j].y);
      if(d<110){ctx.globalAlpha=1-d/110;ctx.beginPath();ctx.moveTo(nodes[i].x,nodes[i].y);ctx.lineTo(nodes[j].x,nodes[j].y);ctx.stroke();}}
    ctx.globalAlpha=1;
    for(const n of nodes){const pulse=1.6+Math.sin(t/500+n.p)*1.2;ctx.fillStyle="rgba(160,200,255,.9)";ctx.beginPath();ctx.arc(n.x,n.y,2.4+pulse*.4,0,6.28);ctx.fill();}
    requestAnimationFrame(f);
  })(0);
})();

/* ---------- sparkline ---------- */
(function(){const s=document.getElementById("spark");if(!s)return;
  s.innerHTML=[20,34,28,45,40,58,52,70,64,82,76,100].map(v=>`<i style="height:${v}%"></i>`).join("");})();

/* ---------- count up ---------- */
function runCount(el){
  const t=parseFloat(el.dataset.count),pre=el.dataset.pre||"",suf=el.dataset.suf||"";
  const dec=(t%1!==0)?(String(t).split(".")[1]||"").length:0;let st=null;
  (function step(ts){if(!st)st=ts;const k=Math.min((ts-st)/1500,1),e=1-Math.pow(1-k,3);
    el.textContent=pre+(t*e).toFixed(dec)+suf;if(k<1)requestAnimationFrame(step);})();
}

/* ---------- reveal + counts ---------- */
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){
  e.target.classList.add("show");e.target.querySelectorAll("[data-count]").forEach(runCount);io.unobserve(e.target);}}),{threshold:.14});
document.querySelectorAll(".rv").forEach(el=>io.observe(el));
addEventListener("load",()=>document.querySelectorAll(".rv").forEach(el=>{
  if(el.getBoundingClientRect().top<innerHeight){el.classList.add("show");el.querySelectorAll("[data-count]").forEach(runCount);}}));

/* ---------- scroll-spy (only when hash sections exist) ---------- */
const spyIds=["numbers","network","build","ecosystem"].filter(id=>document.getElementById(id));
if(spyIds.length){
  const links=[...document.querySelectorAll(".navlinks a")];
  const spy=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting)
    links.forEach(l=>l.classList.toggle("on",l.getAttribute("href")==="#"+e.target.id));}),{rootMargin:"-40% 0px -55% 0px"});
  spyIds.forEach(id=>spy.observe(document.getElementById(id)));
}
})();
