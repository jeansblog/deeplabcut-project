const videoInput = document.getElementById('videoInput');
      const submitBtn = document.getElementById('submitBtn');
      const status = document.getElementById('status');
      const results = document.getElementById('results');
      let currentJobId = null;

      submitBtn.addEventListener('click', async () => {
        const file = videoInput.files[0];
        if (!file) {
          setStatus('動画を選択してください', 'error');
          return;
        }

        const formData = new FormData();
        formData.append('file', file);

        submitBtn.disabled = true;
        results.innerHTML = '';
        setStatus('アップロード中...', '');

        try {
          const res = await fetch('/api/inference', { method: 'POST', body: formData });
          const data = await res.json();

          if (!res.ok) {
            throw new Error(data.detail || 'アップロードに失敗しました');
          }

          currentJobId = data.job_id;
          setStatus(`ジョブ開始: ${data.job_id}`, '');
          pollJob(data.job_id);
        } catch (err) {
          setStatus(String(err), 'error');
          submitBtn.disabled = false;
        }
      });

      function setStatus(message, type) {
        status.textContent = message;
        status.className = 'status';
        if (type === 'ok') status.classList.add('ok');
        if (type === 'error') status.classList.add('error');
      }

      async function pollJob(jobId) {
        const res = await fetch(`/api/jobs/${jobId}`);
        const data = await res.json();

        if (data.status === 'processing' || data.status === 'queued') {
          setStatus(`状態: ${data.status}`, '');
          setTimeout(() => pollJob(jobId), 2000);
          return;
        }

        if (data.status === 'failed') {
          setStatus(`推論失敗: ${data.error || 'unknown error'}`, 'error');
          submitBtn.disabled = false;
          return;
        }

        setStatus('推論完了', 'ok');
        await renderResult(data);
        submitBtn.disabled = false;
      }

      async function renderResult(data) {
        const files = data.result_files || [];
        const videoUrl = data.video_url;
        const jsonFile = files.find(file => file.extension === '.json');

        const resultCards = [];
        const motionCards = [];
        const videoToolsCards = [];

        if (videoUrl) {
          resultCards.push(`
            <div class="card">
              <h2>ラベル付き動画</h2>
              <video controls src="${videoUrl}"></video>
            </div>
          `);
        }

        if (jsonFile) {
          motionCards.push(`
            <section class="card">
              <h2>キーポイントの動き・距離と時間の評価</h2>
              <div class="chart-controls">
                <label>個体枠<select id="motionIndividual"></select></label>
                <label>キーポイント<select id="motionBodypart"></select></label>
                <label>動画のFPS
                  <input id="motionFps" type="number" min="0" step="any" placeholder="例: 30" />
                </label>
                <label>pixels_per_cm（1 cm あたりの px）
                  <input id="pixelsPerCm" type="number" min="0" step="any" placeholder="例: 12.5" />
                </label>
              </div>
              <p class="muted chart-note">FPS と pixels_per_cm は撮影条件に合わせて入力してください。pixels_per_cm は基準物の px 数 ÷ 実寸 (cm) です（例: 10 cm が 125 px なら 12.5）。値はこのサーバーのJSON設定ファイルに自動保存されます。</p>
              <p id="motionSettingsMessage" class="muted chart-note" role="status"></p>
              <dl class="motion-metrics" aria-live="polite">
                <div class="motion-metric"><dt>移動距離</dt><dd id="totalDistance">未設定</dd></div>
                <div class="motion-metric"><dt>経過時間</dt><dd id="elapsedTime">未設定</dd></div>
                <div class="motion-metric"><dt>平均速度</dt><dd id="averageSpeed">未設定</dd></div>
                <div class="motion-metric"><dt>有効なフレーム間</dt><dd id="validIntervals">未設定</dd></div>
              </dl>
              <p id="motionMessage" class="muted" role="status">座標データを読み込んでいます...</p>
              <div class="chart-grid">
                <section class="chart-panel">
                  <h3>X・Y 座標のフレーム推移</h3>
                  <div class="chart-legend">
                    <span class="legend-item"><i class="legend-swatch" style="background:#167d9a"></i>X</span>
                    <span class="legend-item"><i class="legend-swatch" style="background:#d45d45"></i>Y</span>
                  </div>
                  <canvas id="coordinateChart" aria-label="フレームごとのX座標とY座標" role="img"></canvas>
                  <p class="muted chart-note">横軸: フレーム / 縦軸: 位置（px）</p>
                </section>
                <section class="chart-panel">
                  <h3>XY 軌跡</h3>
                  <canvas id="trajectoryChart" aria-label="動画内のXY軌跡" role="img"></canvas>
                  <p class="muted chart-note">映像座標のため、Y は下向きに増加します（px）。</p>
                </section>
                <section class="chart-panel wide">
                  <h3>時間ごとの移動</h3>
                  <canvas id="displacementChart" aria-label="時間ごとの移動速度" role="img"></canvas>
                  <p id="displacementNote" class="muted chart-note">隣接する有効フレーム間の移動距離（px/frame）。未検出区間は線をつなぎません。</p>
                </section>
              </div>
            </section>
          `);

          videoToolsCards.push(`
            <section class="card">
              <h2>軌跡・骨格動画</h2>
              <h3>元動画に軌跡を描画</h3>
              <p class="muted chart-note">選択したキーポイントを色分けし、信頼度の下限以上の軌跡だけをMP4に書き出します。検出が途切れた区間は線をつなぎません。</p>
              <div id="trajectoryBodyparts" class="trajectory-points"></div>
              <div class="upload-box">
                <button id="exportTrajectoryBtn" type="button">軌跡入りMP4を作成</button>
              </div>
              <p id="trajectoryExportMessage" class="muted chart-note" role="status"></p>
              <video id="trajectoryPreview" controls playsinline hidden></video>
              <div id="trajectoryDownload" class="file-list"></div>
              <h3>骨格動画</h3>
              <fieldset class="skeleton-mode">
                <legend>背景</legend>
                <label><input type="radio" name="skeletonBackground" value="video" checked />元動画</label>
                <label><input type="radio" name="skeletonBackground" value="black" />黒背景</label>
              </fieldset>
              <div class="upload-box">
                <button id="exportSkeletonBtn" type="button">骨格動画を作成</button>
              </div>
              <p id="skeletonExportMessage" class="muted chart-note" role="status"></p>
              <video id="skeletonPreview" controls playsinline hidden></video>
              <div id="skeletonDownload" class="file-list"></div>
            </section>
          `);
        }

        resultCards.push(`
          <div class="card">
            <h2>生成ファイル</h2>
            <div class="file-list">
              ${files.map(file => `<a class="file-pill" href="${file.url}" target="_blank" rel="noopener">${file.name}</a>`).join('')}
            </div>
          </div>
        `);

        resultCards.push(`
          <div class="card">
            <h2>JSON</h2>
            <pre>${JSON.stringify(data.result || {}, null, 2)}</pre>
          </div>
        `);

        results.innerHTML = `
          <div class="result-tabs">
            <div class="result-global-controls">
              <label for="confidenceThreshold">信頼度の下限 <output id="confidenceValue">0.50</output></label>
              <input id="confidenceThreshold" type="range" min="0" max="1" step="0.05" value="0.5" />
            </div>
            <div class="tab-list" role="tablist" aria-label="推論結果">
              <button id="resultTab" class="tab-button" type="button" role="tab" aria-selected="true" aria-controls="resultPanel" tabindex="0">推論結果</button>
              <button id="motionTab" class="tab-button" type="button" role="tab" aria-selected="false" aria-controls="motionPanel" tabindex="-1">動き・距離と時間</button>
              <button id="videoToolsTab" class="tab-button" type="button" role="tab" aria-selected="false" aria-controls="videoToolsPanel" tabindex="-1">軌跡・骨格動画</button>
            </div>
            <section id="resultPanel" class="tab-panel" role="tabpanel" aria-labelledby="resultTab" tabindex="0">
              ${resultCards.join('')}
            </section>
            <section id="motionPanel" class="tab-panel" role="tabpanel" aria-labelledby="motionTab" tabindex="0" hidden>
              ${motionCards.join('') || '<div class="card"><p class="muted">評価には座標JSONが必要です。</p></div>'}
            </section>
            <section id="videoToolsPanel" class="tab-panel" role="tabpanel" aria-labelledby="videoToolsTab" tabindex="0" hidden>
              ${videoToolsCards.join('') || '<div class="card"><p class="muted">動画作成には座標JSONが必要です。</p></div>'}
            </section>
          </div>
        `;
        setupResultTabs();
        if (jsonFile) await loadMotionData(jsonFile.url);
      }

      function setupResultTabs() {
        const tabs = Array.from(results.querySelectorAll('[role="tab"]'));
        const activate = (activeTab, focus = false) => {
          for (const tab of tabs) {
            const selected = tab === activeTab;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
          }
          if (activeTab.id === 'motionTab') drawMotionCharts();
          if (focus) activeTab.focus();
        };

        tabs.forEach((tab, index) => {
          tab.addEventListener('click', () => activate(tab));
          tab.addEventListener('keydown', event => {
            let nextIndex;
            if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
            if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
            if (event.key === 'Home') nextIndex = 0;
            if (event.key === 'End') nextIndex = tabs.length - 1;
            if (nextIndex !== undefined) {
              event.preventDefault();
              activate(tabs[nextIndex], true);
            }
          });
        });
      }

      const BODY_PARTS = [
        '鼻', '上顎', '下顎', '口角（右）', '口角（左）',
        '右目', '右耳の付け根', '右耳の先端', '右角の付け根', '右角の先端',
        '左目', '左耳の付け根', '左耳の先端', '左角の付け根', '左角の先端',
        '首の付け根', '首の先端', '喉の付け根', '喉の先端', '背中の前端', '背中の後端',
        '背中の中央', '尾の付け根', '尾の先端', '左前脚のもも', '左前脚の膝',
        '左前足', '右前脚のもも', '右前脚の膝', '右前足',
        '左後足', '左後脚のもも', '右後脚のもも', '左後脚の膝',
        '右後脚の膝', '右後足', '腹部の下端', '体側中央（右）', '体側中央（左）'
      ];
      let motionFrames = [];

      async function loadMotionData(url) {
        const message = document.getElementById('motionMessage');
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`JSON の取得に失敗しました (${response.status})`);
          motionFrames = await response.json();
          if (!Array.isArray(motionFrames) || motionFrames.length === 0) throw new Error('座標データがありません');

          const settingsMessage = document.getElementById('motionSettingsMessage');
          try {
            const settingsResponse = await fetch('/api/settings/motion');
            if (!settingsResponse.ok) throw new Error(`設定の読み込みに失敗しました (${settingsResponse.status})`);
            const settings = await settingsResponse.json();
            document.getElementById('motionFps').value = settings.fps ?? '';
            document.getElementById('pixelsPerCm').value = settings.pixels_per_cm ?? '';
          } catch (error) {
            settingsMessage.textContent = `設定を読み込めませんでした: ${error.message}`;
            settingsMessage.classList.add('error');
          }

          const individualCount = motionFrames[0].bodyparts.length;
          const bodypartCount = motionFrames[0].bodyparts[0]?.length || 0;
          const individualSelect = document.getElementById('motionIndividual');
          const bodypartSelect = document.getElementById('motionBodypart');
          individualSelect.innerHTML = Array.from({ length: individualCount }, (_, index) =>
            `<option value="${index}">animal${index}</option>`
          ).join('');
          bodypartSelect.innerHTML = Array.from({ length: bodypartCount }, (_, index) => {
            const name = BODY_PARTS[index] || `point_${index + 1}`;
            return `<option value="${index}">${name}</option>`;
          }).join('');
          const trajectoryBodyparts = document.getElementById('trajectoryBodyparts');
          trajectoryBodyparts.innerHTML = Array.from({ length: bodypartCount }, (_, index) => {
            const name = BODY_PARTS[index] || `point_${index + 1}`;
            return `<label><input type="checkbox" value="${index}" />${name}</label>`;
          }).join('');
          individualSelect.addEventListener('change', drawMotionCharts);
          bodypartSelect.addEventListener('change', drawMotionCharts);
          document.getElementById('exportTrajectoryBtn').addEventListener('click', exportTrajectoryVideo);
          document.getElementById('exportSkeletonBtn').addEventListener('click', exportSkeletonVideo);
          document.getElementById('motionFps').addEventListener('input', drawMotionCharts);
          document.getElementById('pixelsPerCm').addEventListener('input', drawMotionCharts);
          document.getElementById('motionFps').addEventListener('change', saveMotionSettings);
          document.getElementById('pixelsPerCm').addEventListener('change', saveMotionSettings);
          document.getElementById('confidenceThreshold').addEventListener('input', event => {
            document.getElementById('confidenceValue').textContent = Number(event.target.value).toFixed(2);
            drawMotionCharts();
          });
          message.textContent = `${motionFrames.length} フレームの座標を表示中。信頼度がしきい値未満の点と未検出点は除外します。`;
          drawMotionCharts();
        } catch (error) {
          message.textContent = `グラフを表示できません: ${error.message}`;
          message.classList.add('error');
        }
      }

      async function exportTrajectoryVideo() {
        const button = document.getElementById('exportTrajectoryBtn');
        const message = document.getElementById('trajectoryExportMessage');
        const download = document.getElementById('trajectoryDownload');
        const preview = document.getElementById('trajectoryPreview');
        const bodyparts = Array.from(
          document.querySelectorAll('#trajectoryBodyparts input:checked'),
          checkbox => Number(checkbox.value)
        );
        if (bodyparts.length === 0) {
          message.textContent = '軌跡を描画するキーポイントを1つ以上選択してください。';
          message.classList.add('error');
          return;
        }

        button.disabled = true;
        download.replaceChildren();
        preview.pause();
        preview.removeAttribute('src');
        preview.hidden = true;
        message.textContent = '軌跡入りMP4を作成中です。動画の長さによって時間がかかります...';
        message.classList.remove('error');
        try {
          const response = await fetch(`/api/jobs/${currentJobId}/trajectory-video`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              individual: Number(document.getElementById('motionIndividual').value),
              bodyparts,
              confidence_threshold: Number(document.getElementById('confidenceThreshold').value)
            })
          });
          const file = await response.json();
          if (!response.ok) throw new Error(file.detail || `動画作成に失敗しました (${response.status})`);

          const link = document.createElement('a');
          link.className = 'file-pill';
          link.href = file.url;
          link.download = file.name;
          link.textContent = `ダウンロード: ${file.name}`;
          download.append(link);
          preview.src = file.url;
          preview.hidden = false;
          preview.load();
          message.textContent = '軌跡入りMP4を作成しました。';
        } catch (error) {
          message.textContent = `動画を作成できませんでした: ${error.message}`;
          message.classList.add('error');
        } finally {
          button.disabled = false;
        }
      }

      async function exportSkeletonVideo() {
        const button = document.getElementById('exportSkeletonBtn');
        const message = document.getElementById('skeletonExportMessage');
        const download = document.getElementById('skeletonDownload');
        const preview = document.getElementById('skeletonPreview');
        button.disabled = true;
        download.replaceChildren();
        preview.pause();
        preview.removeAttribute('src');
        preview.hidden = true;
        message.textContent = '骨格動画を作成中です...';
        message.classList.remove('error');
        try {
          const response = await fetch(`/api/jobs/${currentJobId}/skeleton-video`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              individual: Number(document.getElementById('motionIndividual').value),
              confidence_threshold: Number(document.getElementById('confidenceThreshold').value),
              show_background: document.querySelector('input[name="skeletonBackground"]:checked').value === 'video'
            })
          });
          const file = await response.json();
          if (!response.ok) throw new Error(file.detail || `動画作成に失敗しました (${response.status})`);

          const link = document.createElement('a');
          link.className = 'file-pill';
          link.href = file.url;
          link.download = file.name;
          link.textContent = `ダウンロード: ${file.name}`;
          download.append(link);
          preview.src = file.url;
          preview.hidden = false;
          preview.load();
          message.textContent = '骨格動画を作成しました。';
        } catch (error) {
          message.textContent = `動画を作成できませんでした: ${error.message}`;
          message.classList.add('error');
        } finally {
          button.disabled = false;
        }
      }

      async function saveMotionSettings() {
        const settingsMessage = document.getElementById('motionSettingsMessage');
        const readPositiveNumber = id => {
          const value = document.getElementById(id).value.trim();
          if (value === '') return null;
          const number = Number(value);
          return Number.isFinite(number) && number > 0 ? number : NaN;
        };
        const fps = readPositiveNumber('motionFps');
        const pixelsPerCm = readPositiveNumber('pixelsPerCm');
        if (Number.isNaN(fps) || Number.isNaN(pixelsPerCm)) {
          settingsMessage.textContent = 'FPS と pixels_per_cm は空欄または 0 より大きい数値を入力してください。';
          settingsMessage.classList.add('error');
          return;
        }

        try {
          const response = await fetch('/api/settings/motion', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fps, pixels_per_cm: pixelsPerCm })
          });
          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || `設定の保存に失敗しました (${response.status})`);
          }
          settingsMessage.textContent = '設定を保存しました。次回以降もこの値を使用します。';
          settingsMessage.classList.remove('error');
        } catch (error) {
          settingsMessage.textContent = `設定を保存できませんでした: ${error.message}`;
          settingsMessage.classList.add('error');
        }
      }

      function selectedPoints() {
        const individual = Number(document.getElementById('motionIndividual').value);
        const bodypart = Number(document.getElementById('motionBodypart').value);
        const threshold = Number(document.getElementById('confidenceThreshold').value);
        return motionFrames.map((frame, index) => {
          const point = frame.bodyparts?.[individual]?.[bodypart];
          if (!point || point[0] < 0 || point[1] < 0 || point[2] < threshold) return null;
          return { frame: index, x: point[0], y: point[1], likelihood: point[2] };
        });
      }

      function drawMotionCharts() {
        if (!motionFrames.length) return;
        const points = selectedPoints();
        const fps = Number(document.getElementById('motionFps').value);
        const pixelsPerCm = Number(document.getElementById('pixelsPerCm').value);
        const hasFps = Number.isFinite(fps) && fps > 0;
        const hasScale = Number.isFinite(pixelsPerCm) && pixelsPerCm > 0;
        drawLineChart(document.getElementById('coordinateChart'), [
          { name: 'X', color: '#167d9a', values: points.map(point => point && { frame: point.frame, value: point.x }) },
          { name: 'Y', color: '#d45d45', values: points.map(point => point && { frame: point.frame, value: point.y }) }
        ], '位置 (px)');
        drawTrajectoryChart(document.getElementById('trajectoryChart'), points);

        const validPoints = points.filter(Boolean);
        const intervals = [];
        for (let index = 1; index < points.length; index += 1) {
          const point = points[index];
          const previous = points[index - 1];
          if (!point || !previous || point.frame - previous.frame !== 1) continue;
          intervals.push({
            frame: point.frame,
            distancePx: Math.hypot(point.x - previous.x, point.y - previous.y)
          });
        }

        const totalDistancePx = intervals.reduce((total, interval) => total + interval.distancePx, 0);
        const elapsedFrames = validPoints.length > 1
          ? validPoints[validPoints.length - 1].frame - validPoints[0].frame
          : 0;
        const elapsedSeconds = hasFps ? elapsedFrames / fps : null;
        const elapsedLabel = document.getElementById('elapsedTime');
        const distanceLabel = document.getElementById('totalDistance');
        const speedLabel = document.getElementById('averageSpeed');
        const intervalLabel = document.getElementById('validIntervals');

        elapsedLabel.textContent = hasFps && elapsedSeconds !== null
          ? `${elapsedSeconds.toFixed(2)} 秒`
          : 'FPSを入力';
        distanceLabel.textContent = hasScale
          ? `${(totalDistancePx / pixelsPerCm).toFixed(2)} cm`
          : '換算値を入力';
        speedLabel.textContent = hasFps && hasScale && elapsedSeconds > 0
          ? `${(totalDistancePx / pixelsPerCm / elapsedSeconds).toFixed(2)} cm/s`
          : 'FPSと換算値を入力';
        intervalLabel.textContent = elapsedFrames > 0
          ? `${intervals.length} / ${elapsedFrames} 区間`
          : `${intervals.length} 区間`;

        const usePhysicalUnits = hasFps && hasScale;
        const xMaximum = usePhysicalUnits
          ? Math.max((motionFrames.length - 1) / fps, 1 / fps)
          : Math.max(motionFrames.length - 1, 1);
        const displacementValues = intervals.map(interval => ({
          x: usePhysicalUnits ? (interval.frame - 0.5) / fps : interval.frame - 0.5,
          value: usePhysicalUnits
            ? interval.distancePx / pixelsPerCm * fps
            : interval.distancePx
        }));
        const displacementNote = document.getElementById('displacementNote');
        displacementNote.textContent = usePhysicalUnits
          ? '各棒は隣接フレーム間から算出した速度（cm/s）を表します。横軸は時間（秒）。未検出区間は棒を表示しません。'
          : '各棒は隣接フレーム間の移動距離（px/frame）を表します。未検出区間は棒を表示しません。FPS と換算値を入力すると速度（cm/s）で表示します。';
        drawBarChart(document.getElementById('displacementChart'), displacementValues,
        usePhysicalUnits ? '速度 (cm/s)' : '距離 (px/frame)',
        usePhysicalUnits ? '時間 (秒)' : 'フレーム',
        xMaximum, Math.max(motionFrames.length - 1, 1), usePhysicalUnits ? 1 : 0);
      }

      function setupCanvas(canvas) {
        const ratio = window.devicePixelRatio || 1;
        const width = Math.max(canvas.clientWidth, 320);
        const height = Math.max(canvas.clientHeight, 180);
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        const context = canvas.getContext('2d');
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);
        context.font = '12px sans-serif';
        context.fillStyle = '#64748b';
        return { context, width, height };
      }

      function drawLineChart(canvas, series, yLabel, xLabel = 'フレーム', xMaximum = motionFrames.length - 1, yPrecision = 0) {
        const { context, width, height } = setupCanvas(canvas);
        const margin = { top: 14, right: 16, bottom: 34, left: 52 };
        const plotWidth = width - margin.left - margin.right;
        const plotHeight = height - margin.top - margin.bottom;
        const values = series.flatMap(item => item.values.filter(Boolean).map(point => point.value));
        if (!values.length) {
          context.fillText('表示できる点がありません', margin.left, margin.top + 22);
          return;
        }
        let minimum = Math.min(...values);
        let maximum = Math.max(...values);
        if (minimum === maximum) { minimum -= 1; maximum += 1; }
        const xAxisMaximum = Math.max(xMaximum, Number.EPSILON);
        const yFor = value => margin.top + (maximum - value) / (maximum - minimum) * plotHeight;

        context.strokeStyle = '#e5e7eb';
        context.fillStyle = '#64748b';
        context.lineWidth = 1;
        for (let tick = 0; tick <= 4; tick += 1) {
          const y = margin.top + plotHeight * tick / 4;
          const value = maximum - (maximum - minimum) * tick / 4;
          context.beginPath(); context.moveTo(margin.left, y); context.lineTo(width - margin.right, y); context.stroke();
          context.fillText(value.toFixed(yPrecision), 6, y + 4);
        }
        context.fillText('0', margin.left, height - 10);
        context.fillText(xAxisMaximum.toFixed(xLabel === '時間 (秒)' ? 2 : 0), width - margin.right - 40, height - 10);
        context.fillText(xLabel, width - margin.right - 50, 12);
        context.fillText(yLabel, margin.left, 12);

        for (const item of series) {
          context.strokeStyle = item.color;
          context.lineWidth = 2;
          context.beginPath();
          let drawing = false;
          item.values.forEach((point, index) => {
            if (!point) { drawing = false; return; }
            const xValue = point.x ?? point.frame;
            const x = margin.left + xValue / xAxisMaximum * plotWidth;
            const y = yFor(point.value);
            if (drawing && item.values[index - 1]?.frame === point.frame - 1) context.lineTo(x, y);
            else context.moveTo(x, y);
            drawing = true;
          });
          context.stroke();
        }
      }

      function drawBarChart(canvas, points, yLabel, xLabel, xMaximum, barSlots, yPrecision) {
        const { context, width, height } = setupCanvas(canvas);
        const margin = { top: 14, right: 16, bottom: 34, left: 52 };
        const plotWidth = width - margin.left - margin.right;
        const plotHeight = height - margin.top - margin.bottom;
        if (!points.length) {
          context.fillText('表示できる点がありません', margin.left, margin.top + 22);
          return;
        }

        const maximum = Math.max(...points.map(point => point.value), 0) || 1;
        const xAxisMaximum = Math.max(xMaximum, Number.EPSILON);
        const yFor = value => margin.top + (maximum - value) / maximum * plotHeight;
        const slotWidth = plotWidth / Math.max(barSlots, 1);
        const barWidth = Math.max(1, slotWidth * 0.8);

        context.strokeStyle = '#e5e7eb';
        context.fillStyle = '#64748b';
        context.lineWidth = 1;
        for (let tick = 0; tick <= 4; tick += 1) {
          const y = margin.top + plotHeight * tick / 4;
          const value = maximum * (1 - tick / 4);
          context.beginPath(); context.moveTo(margin.left, y); context.lineTo(width - margin.right, y); context.stroke();
          context.fillText(value.toFixed(yPrecision), 6, y + 4);
        }

        context.fillStyle = '#2b7a50';
        for (const point of points) {
          const centerX = margin.left + point.x / xAxisMaximum * plotWidth;
          const top = yFor(point.value);
          context.fillRect(centerX - barWidth / 2, top, barWidth, margin.top + plotHeight - top);
        }

        context.fillStyle = '#64748b';
        context.fillText('0', margin.left, height - 10);
        context.fillText(xAxisMaximum.toFixed(xLabel === '時間 (秒)' ? 2 : 0), width - margin.right - 40, height - 10);
        context.fillText(xLabel, width - margin.right - 50, 12);
        context.fillText(yLabel, margin.left, 12);
      }

      function drawTrajectoryChart(canvas, points) {
        const { context, width, height } = setupCanvas(canvas);
        const valid = points.filter(Boolean);
        const margin = { top: 14, right: 16, bottom: 34, left: 48 };
        const plotWidth = width - margin.left - margin.right;
        const plotHeight = height - margin.top - margin.bottom;
        if (!valid.length) {
          context.fillText('表示できる点がありません', margin.left, margin.top + 22);
          return;
        }
        let minX = Math.min(...valid.map(point => point.x));
        let maxX = Math.max(...valid.map(point => point.x));
        let minY = Math.min(...valid.map(point => point.y));
        let maxY = Math.max(...valid.map(point => point.y));
        if (minX === maxX) { minX -= 1; maxX += 1; }
        if (minY === maxY) { minY -= 1; maxY += 1; }
        const xFor = x => margin.left + (x - minX) / (maxX - minX) * plotWidth;
        const yFor = y => margin.top + (y - minY) / (maxY - minY) * plotHeight;

        context.strokeStyle = '#e5e7eb';
        context.fillStyle = '#64748b';
        for (let tick = 0; tick <= 4; tick += 1) {
          const x = margin.left + plotWidth * tick / 4;
          const y = margin.top + plotHeight * tick / 4;
          context.beginPath(); context.moveTo(x, margin.top); context.lineTo(x, height - margin.bottom); context.stroke();
          context.beginPath(); context.moveTo(margin.left, y); context.lineTo(width - margin.right, y); context.stroke();
          context.fillText((minX + (maxX - minX) * tick / 4).toFixed(0), x - 8, height - 10);
          context.fillText((minY + (maxY - minY) * tick / 4).toFixed(0), 4, y + 4);
        }
        context.strokeStyle = '#167d9a';
        context.lineWidth = 1.5;
        context.beginPath();
        let drawing = false;
        points.forEach((point, index) => {
          if (!point) { drawing = false; return; }
          const x = xFor(point.x);
          const y = yFor(point.y);
          if (drawing && points[index - 1]?.frame === point.frame - 1) context.lineTo(x, y);
          else context.moveTo(x, y);
          drawing = true;
        });
        context.stroke();
        context.fillStyle = '#d45d45';
        for (const point of valid) {
          context.beginPath(); context.arc(xFor(point.x), yFor(point.y), 2.5, 0, Math.PI * 2); context.fill();
        }
        context.fillStyle = '#64748b';
        context.fillText('X (px)', width - 52, height - 10);
        context.fillText('Y (px)', 4, 12);
      }

      window.addEventListener('resize', drawMotionCharts);
