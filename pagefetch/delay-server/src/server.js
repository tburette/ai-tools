import express from 'express';

function generateHTML(initial, delay) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Delay Server (${delay}ms)</title>
  <style>
    body { text-align: center; margin-top: 20vh; }
    .error { color: red; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="content">${initial}</div>
  <script>
    (function() {
      var start = Date.now();
      var content = null;
      var rendered = false;
      function render() {
        if (!rendered && content !== null) {
          rendered = true;
          document.querySelector('.content').innerHTML = content;
        }
      }
      fetch('/final').then(function(r) {
        if (!r.ok) throw new Error(r.status);
        return r.text();
      }).then(function(t) {
        content = t;
        var remaining = ${delay} - (Date.now() - start);
        if (remaining <= 0) {
          render();
        } else {
          setTimeout(render, remaining);
        }
      }).catch(function() {
        var err = document.createElement('div');
        err.className = 'error';
        err.textContent = 'Failed to load final content';
        document.body.appendChild(err);
      });
    })();
  </script>
</body>
</html>`;
}

export function createServer(options) {
  const {
    final,
    initial,
    delay,
    port
  } = options;

  const app = express();

  app.get('/', (req, res) => {
    let effectiveDelay = delay;
    if (req.query.delay !== undefined) {
      const parsed = parseInt(req.query.delay, 10);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER) {
        effectiveDelay = parsed;
      }
    }
    res.type('html').send(generateHTML(initial, effectiveDelay));
  });

  app.get('/final', (req, res) => {
    // res.status(500).type('html').send("test error in /final"); // for debug purposes, don't remove
    res.type('html').send(final);
  });

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      resolve(server);
    });
  });
}
