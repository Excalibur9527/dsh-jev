/**
 * dsh-jev —— 客户端半边（设置页）
 *
 * 这个文件是**手写的 DSH 客户端模块**，不需要打包器：
 *   - DSH 的 ClientModuleLoader 以「CJS 工厂」形式执行插件前端包，
 *     所以文件最外层是 window.__ModuleLoader__.load({ id, factory })；
 *   - factory 里只 require('react')（shell 静态表里带的共享模块），
 *     其余全部用 React.createElement，不引入任何额外依赖；
 *   - 设置页注册进 settings.section 槽位，数据经包私有 RPC 通道 /dsh-jev 读写。
 */
window.__ModuleLoader__.load({
  id: 'dsh-jev',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;

    var CHANNEL = '/dsh-jev';
    var NS = 'dsh-jev';
    var QUESTION_TYPES = [
      ['noul', '是 / 否（noul）'],
      ['score', '评分（score）'],
      ['choice', '单选（choice）'],
    ];
    var SAMPLE_STATE =
      '我这个 Stripe 账号已经接了三天了，集成一直失败，我这边订单正在流失，麻烦尽快帮我看看！';

    // #region 样式（跟随主题变量，取不到时用中性回退色）
    var C = {
      text: 'var(--dsw-alias-label-primary, #111827)',
      secondary: 'var(--dsw-alias-label-secondary, #6b7280)',
      border: 'var(--dsw-alias-border-l2, #e5e7eb)',
      bg: 'var(--dsw-alias-bg-base, #ffffff)',
      subtle: 'var(--dsw-alias-bg-secondary, #f6f7f9)',
      brand: 'var(--dsw-alias-brand-primary, #2563eb)',
      danger: 'var(--dsw-alias-label-error, #dc2626)',
      success: 'var(--dsw-alias-label-success, #16a34a)',
    };
    var S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 2px 32px', color: C.text, fontSize: '13px', lineHeight: 1.55, maxWidth: '760px' },
      title: { fontSize: '16px', fontWeight: 600, margin: 0 },
      lead: { margin: '6px 0 0', color: C.secondary },
      card: { border: '1px solid ' + C.border, borderRadius: '10px', padding: '14px 16px', background: C.bg, display: 'flex', flexDirection: 'column', gap: '12px' },
      cardTitle: { fontSize: '13px', fontWeight: 600 },
      row: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 200px', minWidth: '180px' },
      label: { color: C.secondary, fontSize: '12px' },
      hint: { color: C.secondary, fontSize: '11.5px' },
      input: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: '7px', border: '1px solid ' + C.border, background: C.bg, color: C.text, fontSize: '13px', fontFamily: 'inherit' },
      area: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: '7px', border: '1px solid ' + C.border, background: C.bg, color: C.text, fontSize: '12.5px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', minHeight: '62px', resize: 'vertical' },
      btn: { padding: '6px 14px', borderRadius: '7px', border: '1px solid ' + C.border, background: C.subtle, color: C.text, fontSize: '12.5px', cursor: 'pointer', fontFamily: 'inherit' },
      btnPrimary: { padding: '6px 16px', borderRadius: '7px', border: '1px solid ' + C.brand, background: C.brand, color: '#fff', fontSize: '12.5px', cursor: 'pointer', fontFamily: 'inherit' },
      btnTiny: { padding: '3px 9px', borderRadius: '6px', border: '1px solid ' + C.border, background: 'transparent', color: C.secondary, fontSize: '11.5px', cursor: 'pointer', fontFamily: 'inherit' },
      toolbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      qRow: { border: '1px solid ' + C.border, borderRadius: '9px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px', background: C.subtle },
      pre: { margin: 0, padding: '10px 12px', borderRadius: '8px', background: C.subtle, border: '1px solid ' + C.border, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '260px', overflow: 'auto' },
      log: { display: 'flex', flexDirection: 'column', gap: '6px' },
      logRow: { display: 'flex', gap: '8px', alignItems: 'baseline', borderBottom: '1px solid ' + C.border, paddingBottom: '5px' },
      badge: { display: 'inline-block', padding: '1px 7px', borderRadius: '999px', fontSize: '11px', border: '1px solid ' + C.border },
    };
    // #endregion

    /** 统一的 RPC 调用：拆掉 { ok, value } 信封，失败就抛。 */
    function callRpc(ctx, endpoint, payload) {
      return Promise.resolve(ctx.connection.rpc.call(CHANNEL, endpoint, payload)).then(function (res) {
        if (!res || res.ok !== true) {
          throw new Error((res && res.error && res.error.message) || 'RPC 调用失败');
        }
        return res.value;
      });
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value === undefined ? null : value));
    }

    function timeText(ms) {
      try {
        var d = new Date(ms);
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      } catch (error) {
        return '';
      }
    }

    /** 一行：标签 + 控件 + 说明。 */
    function Field(props) {
      return h('label', { style: props.style || S.field },
        h('span', { style: S.label }, props.label),
        props.children,
        props.hint ? h('span', { style: S.hint }, props.hint) : null,
      );
    }

    /** 单条问题定义的编辑器。 */
    function QuestionRow(props) {
      var q = props.value;
      var update = function (patch) {
        var next = Object.assign({}, q, patch);
        props.onChange(next);
      };
      var criteriaHint = q.type === 'choice'
        ? '每行一条：键=说明，例如 billing=Payment or subscription issues'
        : q.type === 'score'
          ? '每行一个等级，从低到高，例如 很平静 / 有点烦 / 非常愤怒'
          : 'noul 不需要 criteria';
      return h('div', { style: S.qRow },
        h('div', { style: S.row },
          h(Field, { label: '字段名（返回的答案键）', style: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '2 1 160px' } },
            h('input', {
              style: S.input, value: q.name || '', placeholder: '例如 is_urgent',
              onChange: function (e) { update({ name: e.target.value }); },
            }),
          ),
          h(Field, { label: '类型', style: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '0 0 150px' } },
            h('select', {
              style: S.input, value: q.type || 'noul',
              onChange: function (e) { update({ type: e.target.value }); },
            }, QUESTION_TYPES.map(function (pair) {
              return h('option', { key: pair[0], value: pair[0] }, pair[1]);
            })),
          ),
          h('div', { style: { display: 'flex', alignItems: 'flex-end', flex: '0 0 auto' } },
            h('button', {
              type: 'button', style: S.btnTiny, onClick: props.onRemove,
            }, '删除'),
          ),
        ),
        h(Field, { label: '判定说明（instructions）', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('input', {
            style: S.input, value: q.instructions || '', placeholder: '例如 The message conveys urgency or time-sensitivity',
            onChange: function (e) { update({ instructions: e.target.value }); },
          }),
        ),
        h(Field, { label: '判定标准（criteria）', hint: criteriaHint, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('textarea', {
            style: S.area, value: (Array.isArray(q.criteria) ? q.criteria : []).join('\n'),
            onChange: function (e) { update({ criteria: e.target.value.split('\n') }); },
          }),
        ),
      );
    }

    /** 设置页主体。 */
    function JevSettingsSection(props) {
      var call = props.call;
      var [view, setView] = useState(null);
      var [draft, setDraft] = useState(null);
      var [keyInput, setKeyInput] = useState('');
      var [notice, setNotice] = useState(null);
      var [busy, setBusy] = useState(null);
      var [testInput, setTestInput] = useState(SAMPLE_STATE);
      var [testResult, setTestResult] = useState(null);

      var adopt = useCallback(function (next) {
        setView(next);
        setDraft(clone(next && next.value));
      }, []);

      var load = useCallback(function () {
        setBusy('load');
        return call('jev.view', {}).then(function (next) {
          adopt(next);
          setNotice(null);
        }).catch(function (error) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[dsh-jev] jev.view failed:', error);
          setNotice({ kind: 'err', text: '读取设置失败：' + String(error && error.message ? error.message : error) });
        }).then(function () {
          setBusy(null);
        });
      }, [call, adopt]);

      useEffect(function () { load(); }, [load]);

      if (view === null || draft === null) {
        // 读设置失败时必须把错误显示出来，否则页面会永远停在“正在读取”。
        var loadingFailed = notice !== null && notice.kind === 'err';
        return h('div', { style: S.wrap },
          h('div', { style: Object.assign({}, S.card, { gap: '10px' }) },
            h('div', { style: loadingFailed ? { color: C.danger } : undefined },
              loadingFailed ? notice.text : '正在读取 JEV 设置…'),
            h('div', { style: S.hint },
              '设置走宿主上的包私有 RPC 通道 ' + CHANNEL + '（仅本机 loopback 可达）。'),
            h('div', { style: S.toolbar },
              h('button', { type: 'button', style: S.btn, disabled: busy !== null, onClick: load }, '重试'),
            ),
          ),
        );
      }

      var patch = function (values) { setDraft(Object.assign({}, draft, values)); };

      var save = function () {
        var body = {
          enabled: draft.enabled === true,
          endpoint: String(draft.endpoint || '').trim(),
          model: String(draft.model || '').trim(),
          timeoutMs: Number(draft.timeoutMs) || 8000,
          maxInputChars: Number(draft.maxInputChars) || 4000,
          injectContext: draft.injectContext === true,
          instruction: String(draft.instruction || ''),
          questions: (draft.questions || []).map(function (q) {
            return {
              name: String(q.name || '').trim(),
              type: q.type || 'noul',
              instructions: String(q.instructions || ''),
              criteria: (Array.isArray(q.criteria) ? q.criteria : []).map(function (line) { return String(line); }).filter(function (line) { return line.trim() !== ''; }),
            };
          }),
        };
        if (keyInput.trim() !== '') body.apiKey = keyInput.trim();
        setBusy('save');
        call('jev.update', { patch: body, expectedRevision: view.revision }).then(function (next) {
          adopt(next);
          setKeyInput('');
          setNotice({ kind: 'ok', text: '已保存到 ' + (next.documentPath || 'settings.yaml') });
        }).catch(function (error) {
          setNotice({ kind: 'err', text: '保存失败：' + String(error && error.message ? error.message : error) });
        }).then(function () { setBusy(null); });
      };

      var clearKey = function () {
        setBusy('key');
        call('jev.clearKey', { expectedRevision: view.revision }).then(function (next) {
          adopt(next);
          setKeyInput('');
          setNotice({ kind: 'ok', text: '已清除保存的 API Key' });
        }).catch(function (error) {
          setNotice({ kind: 'err', text: '清除失败：' + String(error && error.message ? error.message : error) });
        }).then(function () { setBusy(null); });
      };

      var reset = function () {
        setBusy('reset');
        call('jev.reset', { expectedRevision: view.revision }).then(function (next) {
          adopt(next);
          setKeyInput('');
          setNotice({ kind: 'ok', text: '已恢复默认值' });
        }).catch(function (error) {
          setNotice({ kind: 'err', text: '重置失败：' + String(error && error.message ? error.message : error) });
        }).then(function () { setBusy(null); });
      };

      var runTest = function () {
        setBusy('test');
        setTestResult(null);
        call('jev.test', { state: testInput }).then(function (result) {
          setTestResult(result);
        }).catch(function (error) {
          setTestResult({ ok: false, error: String(error && error.message ? error.message : error) });
        }).then(function () { setBusy(null); });
      };

      var keyState = keyInput.trim() !== ''
        ? '待保存（保存后写入 settings.yaml）'
        : view.storedKey
          ? '已保存 ' + (view.documentPath || '')
          : view.envKey
            ? '来自环境变量 TYPESAFE_API_KEY'
            : '未配置';

      var runtime = view.runtime || { recent: [], calls: 0, errors: 0 };

      return h('div', { style: S.wrap },

        h('div', null,
          h('h3', { style: S.title }, 'JEV 情绪 / 意图判定'),
          h('p', { style: S.lead },
            '每一轮对话都会把用户最新一条消息发给 typesafe.ai 的 systemone(jev)，判定结果作为一条运行时上下文注入模型，用来调整语气与优先级。Key 与参数保存在 '
            + (view.documentPath || '~/.dsh/settings.yaml') + ' 的 dsh-jev: 段。'),
        ),

        notice ? h('div', {
          style: Object.assign({}, S.card, {
            borderColor: notice.kind === 'err' ? C.danger : C.border,
            color: notice.kind === 'err' ? C.danger : C.text,
            padding: '8px 12px',
          }),
        }, notice.text) : null,

        // —— 开关与状态 ——
        h('div', { style: S.card },
          h('div', { style: S.toolbar },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox', checked: draft.enabled === true,
                onChange: function (e) { patch({ enabled: e.target.checked }); },
              }),
              h('span', null, '启用 JEV 判定'),
            ),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox', checked: draft.injectContext === true,
                onChange: function (e) { patch({ injectContext: e.target.checked }); },
              }),
              h('span', null, '把判定结果注入模型上下文'),
            ),
            h('span', { style: { flex: '1 1 auto' } }),
            h('span', { style: Object.assign({}, S.badge, { color: view.keySet ? C.success : C.danger }) },
              view.keySet ? 'Key 已配置' : 'Key 未配置'),
            h('span', { style: Object.assign({}, S.badge, { color: C.secondary }) }, 'revision ' + String(view.revision)),
          ),
          h('div', { style: S.hint },
            '判定结果只在“有新用户消息”的那一步调用一次；调用失败或超时会静默跳过，不打断对话。'),
        ),

        // —— 凭据与接口 ——
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '凭据与接口'),
          h(Field, { label: 'API Key', hint: keyState, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('div', { style: { display: 'flex', gap: '8px' } },
              h('input', {
                style: S.input, type: 'password', value: keyInput, autoComplete: 'off', spellCheck: false,
                placeholder: view.keySet ? '已保存，留空表示不修改' : 'apikey_...',
                onChange: function (e) { setKeyInput(e.target.value); },
              }),
              h('button', { type: 'button', style: S.btn, disabled: busy !== null, onClick: clearKey }, '清除'),
            ),
          ),
          h('div', { style: S.row },
            h(Field, { label: '接口地址 endpoint' },
              h('input', {
                style: S.input, value: draft.endpoint || '', spellCheck: false,
                onChange: function (e) { patch({ endpoint: e.target.value }); },
              }),
            ),
            h(Field, { label: '模型 model' },
              h('input', {
                style: S.input, value: draft.model || '', spellCheck: false,
                onChange: function (e) { patch({ model: e.target.value }); },
              }),
            ),
          ),
          h('div', { style: S.row },
            h(Field, { label: '超时（毫秒）', hint: '超时即跳过本轮注入' },
              h('input', {
                style: S.input, type: 'number', value: draft.timeoutMs === undefined ? 8000 : draft.timeoutMs,
                onChange: function (e) { patch({ timeoutMs: Number(e.target.value) }); },
              }),
            ),
            h(Field, { label: '最大输入字符', hint: '超出部分截断后再发送' },
              h('input', {
                style: S.input, type: 'number', value: draft.maxInputChars === undefined ? 4000 : draft.maxInputChars,
                onChange: function (e) { patch({ maxInputChars: Number(e.target.value) }); },
              }),
            ),
          ),
          h(Field, { label: '附加给模型的行为提示', hint: '跟在判定结果后面一起注入，留空则不追加' },
            h('textarea', {
              style: S.area, value: draft.instruction || '',
              onChange: function (e) { patch({ instruction: e.target.value }); },
            }),
          ),
        ),

        // —— 问题定义 ——
        h('div', { style: S.card },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('div', { style: S.cardTitle }, '判定问题（questions）'),
            h('span', { style: S.hint }, '字段名就是返回答案的键；一条有效问题都没有时不会发起请求'),
            h('span', { style: { flex: '1 1 auto' } }),
            h('button', {
              type: 'button', style: S.btn,
              onClick: function () {
                patch({ questions: (draft.questions || []).concat([{ name: '', type: 'noul', instructions: '', criteria: [] }]) });
              },
            }, '添加问题'),
          ),
          (draft.questions || []).length === 0
            ? h('div', { style: S.hint }, '还没有问题定义。')
            : (draft.questions || []).map(function (q, index) {
              return h(QuestionRow, {
                key: index, value: q,
                onChange: function (next) {
                  var list = (draft.questions || []).slice();
                  list[index] = next;
                  patch({ questions: list });
                },
                onRemove: function () {
                  var list = (draft.questions || []).slice();
                  list.splice(index, 1);
                  patch({ questions: list });
                },
              });
            }),
        ),

        // —— 操作 ——
        h('div', { style: S.toolbar },
          h('button', { type: 'button', style: S.btnPrimary, disabled: busy !== null, onClick: save },
            busy === 'save' ? '保存中…' : '保存'),
          h('button', { type: 'button', style: S.btn, disabled: busy !== null, onClick: load }, '重新加载'),
          h('button', { type: 'button', style: S.btn, disabled: busy !== null, onClick: reset }, '恢复默认'),
          h('span', { style: S.hint }, busy === 'key' ? '处理中…' : ''),
        ),

        // —— 测试 ——
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '试跑一次'),
          h('textarea', {
            style: S.area, value: testInput,
            onChange: function (e) { setTestInput(e.target.value); },
          }),
          h('div', { style: S.toolbar },
            h('button', { type: 'button', style: S.btn, disabled: busy !== null, onClick: runTest },
              busy === 'test' ? '请求中…' : '运行测试'),
            h('span', { style: S.hint }, '用当前（已保存的）配置真实请求一次，不注入 & 不进缓存'),
          ),
          testResult
            ? (testResult.ok
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                h('div', { style: S.hint }, '耗时 ' + String(testResult.ms) + ' ms'),
                h('pre', { style: S.pre }, testResult.text || ''),
                h('details', null,
                  h('summary', { style: S.hint }, '原始响应 JSON'),
                  h('pre', { style: S.pre }, JSON.stringify(testResult.payload, null, 2)),
                ),
              )
              : h('div', { style: Object.assign({}, S.pre, { color: C.danger }) }, '测试失败：' + String(testResult.error || '')))
            : null,
        ),

        // —— 最近调用 ——
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '最近调用 · 成功 ' + String(runtime.calls) + ' 次 / 失败 ' + String(runtime.errors) + ' 次'),
          runtime.recent.length === 0
            ? h('div', { style: S.hint }, '还没有调用记录。')
            : h('div', { style: S.log }, runtime.recent.map(function (entry, index) {
              return h('div', { key: index, style: S.logRow },
                h('span', { style: S.hint }, timeText(entry.at)),
                h('span', { style: Object.assign({}, S.badge, { color: entry.ok ? C.success : C.danger }) },
                  entry.ok ? 'ok' : entry.skipped ? 'skip' : 'fail'),
                h('span', { style: S.hint }, entry.ms === undefined ? '' : String(entry.ms) + 'ms'),
                h('span', { style: { flex: '1 1 auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                  entry.error || entry.reason || entry.input || ''),
              );
            })),
          runtime.lastError ? h('div', { style: S.hint }, '最近一次错误：' + runtime.lastError) : null,
        ),
      );
    }

    /** 插件入口：只做注册，UI 全在上面的组件里。 */
    function apply(ctx) {
      var call = function (endpoint, payload) { return callRpc(ctx, endpoint, payload); };
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: NS,
          order: 55,
          label: function () { return 'JEV 情绪分析'; },
          inject: function () { return { call: call }; },
        }, JevSettingsSection);
      });
    }

    module.exports = {
      name: NS,
      inject: ['slots', 'connection'],
      apply: apply,
    };
    return module.exports;
  },
});
