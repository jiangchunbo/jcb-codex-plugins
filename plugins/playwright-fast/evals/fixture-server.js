#!/usr/bin/env node
const http = require("node:http");

function send(response, status, contentType, body, headers = {}) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
}

function layout(title, body, script = "") {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; color: #172033; font: 16px/1.5 system-ui, sans-serif; }
    main { max-width: 900px; margin: 0 auto; }
    label { display: block; margin: 12px 0; }
    input, select, button { min-height: 36px; padding: 6px 10px; }
    button { cursor: pointer; }
    .row { display: flex; align-items: center; gap: 12px; margin: 10px 0; }
    .card { width: calc(100vw - 32px); max-width: 720px; padding: 20px; border: 1px solid #ccd3df; }
    .covered-control { position: relative; width: 240px; height: 38px; }
    .covered-control input { width: 100%; height: 38px; }
    .covered-control span { position: absolute; inset: 0; display: flex; align-items: center; padding: 0 12px; background: transparent; }
    uni-button, .uni-modal__btn { display: inline-flex; min-height: 36px; padding: 8px 14px; border: 1px solid #777; }
  </style>
</head>
<body><main><h1>${title}</h1>${body}</main>
<script>
  const runId = new URL(location.href).searchParams.get('run') || 'manual';
  const record = (key, value) => fetch('/__event/' + encodeURIComponent(runId), {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({key, value}),
    keepalive: true
  });
  ${script}
</script></body></html>`;
}

function createFixtureServer({ port = 0 } = {}) {
  const state = new Map();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    if (request.method === "POST" && url.pathname.startsWith("/__event/")) {
      const runId = decodeURIComponent(url.pathname.slice("/__event/".length));
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        try {
          const event = JSON.parse(raw);
          const current = state.get(runId) || {};
          current[event.key] = event.value;
          state.set(runId, current);
          send(response, 204, "text/plain", "");
        } catch {
          send(response, 400, "text/plain", "invalid event");
        }
      });
      return;
    }

    if (url.pathname.startsWith("/__oracle/")) {
      const runId = decodeURIComponent(url.pathname.slice("/__oracle/".length));
      send(response, 200, "application/json", JSON.stringify(state.get(runId) || {}));
      return;
    }

    if (url.pathname === "/favicon.ico") {
      send(response, 204, "image/x-icon", "");
      return;
    }

    if (url.pathname === "/form") {
      send(response, 200, "text/html; charset=utf-8", layout("订单查询", `
        <form id="search-form">
          <label>客户姓名 <input name="customer" placeholder="请输入客户姓名"></label>
          <label>订单状态 <select name="status"><option>待付款</option><option>已付款</option></select></label>
          <button type="submit">查询</button>
        </form>
        <table aria-label="订单结果"><tbody><tr><td>陈伟</td><td>已付款</td><td>268.00</td></tr></tbody></table>`, `
        document.querySelector('#search-form').onsubmit = (event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          record('search', data.get('customer') + '|' + data.get('status'));
        };`));
      return;
    }

    if (url.pathname === "/rows") {
      send(response, 200, "text/html; charset=utf-8", layout("账号列表", `
        <section class="row"><span>13900000000</span><strong>教师</strong><button data-role="教师">模拟登录</button></section>
        <section class="row"><span>13900000000</span><strong>管理员</strong><button data-role="管理员">模拟登录</button></section>`, `
        document.querySelectorAll('button').forEach(button => button.onclick = () => record('selectedRole', button.dataset.role));`));
      return;
    }

    if (url.pathname === "/responsive") {
      send(response, 200, "text/html; charset=utf-8", layout("移动端卡片", `<section class="card">视口卡片</section>`));
      return;
    }

    if (url.pathname === "/ergonomic") {
      send(response, 200, "text/html; charset=utf-8", layout("编辑资料", `
        <input placeholder="昵称" hidden>
        <label>昵称 <input id="nickname" placeholder="昵称"></label>
        <button id="save">保存</button><p id="ready" hidden>保存完成</p>`, `
        document.querySelector('#save').onclick = () => {
          record('nickname', document.querySelector('#nickname').value);
          setTimeout(() => { document.querySelector('#ready').hidden = false; }, 120);
        };`));
      return;
    }

    if (url.pathname === "/reload") {
      send(response, 200, "text/html; charset=utf-8", layout("刷新计数", `
        <button id="increment">增加计数</button><output id="count">0</output>`, `
        const key = 'playwright-fast-eval-count';
        document.querySelector('#count').value = sessionStorage.getItem(key) || '0';
        document.querySelector('#count').textContent = document.querySelector('#count').value;
        document.querySelector('#increment').onclick = () => {
          const value = String(Number(sessionStorage.getItem(key) || 0) + 1);
          sessionStorage.setItem(key, value);
          document.querySelector('#count').value = value;
          document.querySelector('#count').textContent = value;
          record('count', value);
        };`));
      return;
    }

    if (url.pathname === "/upload") {
      send(response, 200, "text/html; charset=utf-8", layout("上传附件", `
        <label>选择附件 <input id="attachment" type="file"></label><output id="filename"></output>`, `
        document.querySelector('#attachment').onchange = (event) => {
          const name = event.currentTarget.files[0]?.name || '';
          document.querySelector('#filename').textContent = name;
          record('uploaded', name);
        };`));
      return;
    }

    if (url.pathname === "/element") {
      send(response, 200, "text/html; charset=utf-8", layout("Element 选择器", `
        <div id="stage" class="el-select covered-control">
          <input readonly role="combobox" aria-label="学段" placeholder="请选择学段">
          <span>请选择学段</span>
        </div><ul id="options" hidden><li><button>初中</button></li><li><button>高中</button></li></ul>`, `
        document.querySelector('#stage').onclick = () => { document.querySelector('#options').hidden = false; };
        document.querySelectorAll('#options button').forEach(button => button.onclick = () => {
          document.querySelector('#stage span').textContent = button.textContent;
          document.querySelector('#stage input').value = button.textContent;
          document.querySelector('#options').hidden = true;
          record('stage', button.textContent);
        });`));
      return;
    }

    if (url.pathname === "/uni") {
      send(response, 200, "text/html; charset=utf-8", layout("uni-app 控件", `
        <uni-button id="save"><uni-view><span>保存</span></uni-view></uni-button>
        <div id="cancel" class="uni-modal__btn uni-modal__btn_default"><span>取消</span></div>`, `
        document.querySelector('#save').onclick = () => record('uniSave', true);
        document.querySelector('#cancel').onclick = () => record('uniCancel', true);`));
      return;
    }

    if (url.pathname === "/frames") {
      send(response, 200, "text/html; charset=utf-8", layout("框架与窗口", `
        <iframe title="详情" src="/frame-content"></iframe>
        <button id="open" onclick="window.open('/popup')">打开详情窗口</button>`));
      return;
    }

    if (url.pathname === "/frame-content") {
      send(response, 200, "text/html; charset=utf-8", "<!doctype html><h2>框架详情</h2><p>编号 F-2048</p>");
      return;
    }

    if (url.pathname === "/popup") {
      send(response, 200, "text/html; charset=utf-8", "<!doctype html><title>详情窗口</title><main>窗口编号 P-4096</main>");
      return;
    }

    if (url.pathname === "/spa") {
      send(response, 200, "text/html; charset=utf-8", layout("Hash 路由", `<output id="route"></output><output id="result"></output>`, `
        const render = async () => {
          document.querySelector('#route').textContent = location.hash;
          const result = await fetch('/api/hash?value=' + encodeURIComponent(location.hash)).then(r => r.json());
          document.querySelector('#result').textContent = result.value;
        };
        addEventListener('hashchange', render); render();`));
      return;
    }

    if (url.pathname === "/network") {
      send(response, 200, "text/html; charset=utf-8", layout("订单接口", `<button id="load">加载订单</button><output id="first-order"></output>`, `
        document.querySelector('#load').onclick = async () => {
          const result = await fetch('/api/orders?page=1').then(r => r.json());
          document.querySelector('#first-order').textContent = result.data[0].name;
        };`));
      return;
    }

    if (url.pathname === "/cors") {
      send(response, 200, "text/html; charset=utf-8", layout("跨域资料", `<button id="profile">读取资料</button><output id="profile-result"></output>`, `
        document.querySelector('#profile').onclick = async () => {
          const result = await fetch('http://127.0.0.1:1/api/profile?scope=full', {
            credentials: 'include', headers: {'x-eval': 'profile'}
          }).then(r => r.json());
          document.querySelector('#profile-result').textContent = result.name;
          record('corsName', result.name);
        };`));
      return;
    }

    if (url.pathname === "/missing") {
      send(response, 200, "text/html; charset=utf-8", layout("发布状态", `<p>当前没有发布记录</p>`));
      return;
    }

    if (url.pathname === "/api/hash") {
      send(response, 200, "application/json", JSON.stringify({ value: url.searchParams.get("value") }));
      return;
    }

    if (url.pathname === "/api/orders") {
      send(response, 200, "application/json", JSON.stringify({ data: [{ name: "服务端默认订单" }] }));
      return;
    }

    send(response, 404, "text/plain; charset=utf-8", "not found");
  });

  return {
    server,
    state,
    async start() {
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (require.main === module) {
  const fixture = createFixtureServer({ port: Number(process.env.PLAYWRIGHT_FAST_EVAL_PORT || 0) });
  fixture.start().then((origin) => process.stdout.write(`${origin}\n`));
  const stop = () => fixture.close().finally(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

module.exports = { createFixtureServer };
