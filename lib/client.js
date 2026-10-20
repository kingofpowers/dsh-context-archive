window.__ModuleLoader__.load({
  id: 'dsh-context-archive',
  factory: (require) => {
    const React = require('react')

    const API = '/dsh-context-archive'
    const h = React.createElement

    const colors = {
      bg: 'var(--dsw-alias-bg-base, #ffffff)',
      text: 'var(--dsw-alias-label-primary, #222222)',
      sub: 'var(--dsw-alias-label-secondary, #555555)',
      hint: 'var(--dsw-alias-label-tertiary, #888888)',
      border: 'var(--dsw-alias-border-l2, #e5e5e5)',
      accent: 'var(--dsw-alias-button-primary-fill, #4d6bfe)',
      bar: 'var(--dsw-alias-button-primary-fill, #4d6bfe)',
    }

    const styles = {
      root: {
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        height: '100%',
        overflow: 'auto',
        padding: '16px',
        background: colors.bg,
        color: colors.text,
        fontSize: '12px',
      },
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      title: { fontSize: '14px', fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      totals: { display: 'flex', gap: '16px', flexWrap: 'wrap', color: colors.sub },
      table: { width: '100%', borderCollapse: 'collapse' },
      th: {
        textAlign: 'left',
        fontWeight: 500,
        color: colors.hint,
        padding: '4px 6px',
        borderBottom: `1px solid ${colors.border}`,
      },
      td: { padding: '4px 6px', borderBottom: `1px solid ${colors.border}`, verticalAlign: 'middle' },
      num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
      barTrack: { position: 'relative', height: '6px', background: colors.border, borderRadius: '3px', minWidth: '60px' },
      barFill: { position: 'absolute', inset: 0, right: 'auto', background: colors.bar, borderRadius: '3px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '120px' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        padding: '5px 8px',
        borderRadius: '6px',
        border: `1px solid ${colors.border}`,
        background: 'transparent',
        color: colors.text,
        fontSize: '12px',
      },
      button: {
        cursor: 'pointer',
        border: `1px solid ${colors.border}`,
        borderRadius: '6px',
        background: colors.accent,
        color: '#fff',
        padding: '5px 14px',
        fontSize: '12px',
      },
      ghost: {
        cursor: 'pointer',
        border: `1px solid ${colors.border}`,
        borderRadius: '6px',
        background: 'transparent',
        color: colors.sub,
        padding: '4px 10px',
        fontSize: '12px',
      },
      hint: { color: colors.hint, lineHeight: 1.6 },
      ok: { color: '#1a7f37' },
      bad: { color: '#b42318' },
    }

    async function jsonFetch(url, init) {
      const res = await fetch(url, { headers: { accept: 'application/json' }, ...init })
      const text = await res.text()
      const body = text ? JSON.parse(text) : {}
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      return body
    }

    function formatNumber(value) {
      return Number(value ?? 0).toLocaleString('en-US')
    }

    function percent(rate) {
      if (rate === null || rate === undefined) return '—'
      return `${(Number(rate) * 100).toFixed(1)}%`
    }

    function StatRow(props) {
      return h('span', null, `${props.label} `, h('strong', { style: { color: colors.text } }, props.value))
    }

    function BucketTable(props) {
      const buckets = props.buckets ?? []
      const maxSeen = Math.max(1, ...buckets.map((bucket) => bucket.seen))
      return h(
        'table',
        { style: styles.table },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', { style: styles.th }, '大小'),
            h('th', { style: { ...styles.th, ...styles.num } }, '结果数'),
            h('th', { style: { ...styles.th, ...styles.num } }, '已编号'),
            h('th', { style: { ...styles.th, ...styles.num } }, '已归档'),
            h('th', { style: { ...styles.th, ...styles.num } }, '回收率'),
            h('th', { style: { ...styles.th, width: '18%' } }, ''),
            h('th', { style: { ...styles.th, ...styles.num } }, '打平率'),
            h('th', { style: styles.th }, '结论'),
          ),
        ),
        h(
          'tbody',
          null,
          buckets.map((bucket) =>
            h(
              'tr',
              { key: bucket.bucket },
              h('td', { style: styles.td }, bucket.bucket),
              h('td', { style: { ...styles.td, ...styles.num } }, formatNumber(bucket.seen)),
              h('td', { style: { ...styles.td, ...styles.num } }, formatNumber(bucket.annotated)),
              h('td', { style: { ...styles.td, ...styles.num } }, formatNumber(bucket.archived)),
              h('td', { style: { ...styles.td, ...styles.num } }, percent(bucket.rate)),
              h(
                'td',
                { style: styles.td },
                h(
                  'div',
                  { style: styles.barTrack },
                  h('div', {
                    style: {
                      ...styles.barFill,
                      width: `${Math.max(2, Math.round((bucket.seen / maxSeen) * 100))}%`,
                      opacity: bucket.archived > 0 ? 1 : 0.25,
                    },
                  }),
                ),
              ),
              h('td', { style: { ...styles.td, ...styles.num } }, percent(bucket.breakEvenRate)),
              h(
                'td',
                {
                  style: {
                    ...styles.td,
                    color:
                      bucket.verdict === 'profitable' ? '#1a7f37' : bucket.verdict === 'losing' ? '#b42318' : colors.hint,
                  },
                },
                bucket.verdict === 'profitable' ? '划算' : bucket.verdict === 'losing' ? '不划算' : '样本不足',
              ),
            ),
          ),
        ),
      )
    }

    function Field(props) {
      return h(
        'label',
        { style: styles.field },
        h('span', { style: styles.hint }, props.label),
        h('input', {
          type: 'number',
          min: 0,
          step: 1,
          style: styles.input,
          value: props.value,
          onChange: (event) => props.onChange(Number(event.target.value)),
        }),
      )
    }

    function Panel(props) {
      const sessionId = props?.scope?.sessionId
      const [stats, setStats] = React.useState(null)
      const [config, setConfig] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [status, setStatus] = React.useState({ kind: 'idle', text: '' })

      const load = React.useCallback(async () => {
        try {
          setStatus({ kind: 'idle', text: '读取中…' })
          const [nextStats, nextConfig] = await Promise.all([
            jsonFetch(`${API}/stats${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`),
            jsonFetch(`${API}/config`),
          ])
          setStats(nextStats)
          setConfig(nextConfig)
          setDraft(nextConfig.effective)
          setStatus({ kind: 'ok', text: '已刷新' })
        } catch (error) {
          setStatus({ kind: 'bad', text: `读取失败：${error.message}` })
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const save = async () => {
        try {
          setStatus({ kind: 'idle', text: '保存中…' })
          await jsonFetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              minChars: draft.minChars,
              nudge: draft.nudge,
              maxAnnotated: draft.maxAnnotated,
              keepTurns: draft.keepTurns,
              minChars: draft.minChars,
              annotate: draft.annotate,
            }),
          })
          setStatus({ kind: 'ok', text: '已保存，下一条工具结果立即生效（无需重启）' })
          const nextConfig = await jsonFetch(`${API}/config`)
          setConfig(nextConfig)
          setDraft(nextConfig.effective)
        } catch (error) {
          setStatus({ kind: 'bad', text: `保存失败：${error.message}` })
        }
      }

      if (!draft) {
        return h('div', { style: styles.root }, h('div', { style: styles.title }, '上下文归档'), h('div', { style: styles.hint }, status.text || '加载中…'))
      }

      const totals = stats?.totals ?? { seen: 0, annotated: 0, archived: 0, rate: 0, prefixCost: 25 }
      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.header },
          h('div', { style: styles.title }, '上下文归档'),
          h('button', { type: 'button', style: styles.ghost, onClick: load }, '刷新统计'),
        ),
        stats?.current
          ? h(
              'div',
              { style: { ...styles.totals, padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: '8px' } },
              h(StatRow, { label: '当前会话 surface', value: formatNumber(stats.current.surface) }),
              h(StatRow, { label: '可归档', value: formatNumber(stats.current.archivable) }),
              h(StatRow, { label: '已归档', value: formatNumber(stats.current.archived) }),
              h(StatRow, { label: '潜在可省', value: `≈ ${formatNumber(stats.current.potentialChars)} 字符` }),
            )
          : null,
        h('div', { style: styles.hint }, '历史样本（全部会话，只用于估算回收率）'),
        h(
          'div',
          { style: styles.totals },
          h(StatRow, { label: '结果总数', value: formatNumber(totals.seen) }),
          h(StatRow, { label: '已编号', value: formatNumber(totals.annotated) }),
          h(StatRow, { label: '已归档', value: formatNumber(totals.archived) }),
          h(StatRow, { label: '回收率', value: percent(totals.rate) }),
          h(StatRow, { label: '前缀成本', value: `${totals.prefixCost} 字符/条` }),
          h(StatRow, { label: '样本门槛', value: `${stats?.minSample ?? 3} 条/桶` }),
        ),
        h(BucketTable, { buckets: stats?.buckets ?? [] }),
        h(
          'div',
          { style: styles.hint },
          stats?.recommendedMinChars
            ? `已观测到首个划算的区间，阈值 ≥ ${formatNumber(stats.recommendedMinChars)}。`
            : '还没有观察到"回收率 ≥ 打平率"的区间：样本不足，继续用一段时间再回来看。',
        ),
        h('div', { style: { height: '1px', background: colors.border } }),
        h('div', { style: styles.hint }, '阈值（保存后立即生效）'),
        h(
          'div',
          { style: styles.row },
          h(Field, {
            label: '编号/清单阈值 minChars',
            value: draft.minChars,
            onChange: (value) => setDraft({ ...draft, minChars: value }),
          }),
          h(Field, {
            label: '同时带编号上限 maxAnnotated',
            value: draft.maxAnnotated,
            onChange: (value) => setDraft({ ...draft, maxAnnotated: value }),
          }),
          h(Field, {
            label: '轮次护栏 keepTurns',
            value: draft.keepTurns,
            onChange: (value) => setDraft({ ...draft, keepTurns: value }),
          }),
          h(
            'label',
            { style: { ...styles.field, minWidth: '80px' } },
            h('span', { style: styles.hint }, '提醒归档'),
            h('input', {
              type: 'checkbox',
              checked: Boolean(draft.nudge),
              onChange: (event) => setDraft({ ...draft, nudge: event.target.checked }),
            }),
          ),
          h(
            'label',
            { style: { ...styles.field, minWidth: '80px' } },
            h('span', { style: styles.hint }, '内联编号'),
            h('input', {
              type: 'checkbox',
              checked: Boolean(draft.annotate),
              onChange: (event) => setDraft({ ...draft, annotate: event.target.checked }),
            }),
          ),
          h('button', { type: 'button', style: styles.button, onClick: save }, '保存'),
        ),
        h(
          'div',
          { style: { ...styles.hint, color: status.kind === 'bad' ? '#b42318' : status.kind === 'ok' ? '#1a7f37' : colors.hint } },
          status.text,
        ),
        h(
          'div',
          { style: styles.hint },
          `配置文件：${config?.path ?? '~/.dsh/context-archive.json'} —— 手改这个文件同样即时生效。`,
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.betterSidebar.registerTab({
            id: 'context-archive:stats',
            title: '上下文归档',
            description: '按结果大小分桶的回收率统计，以及归档阈值设置。',
            order: 130,
            single: true,
            icon: '🗄️',
            component: (props) => h(Panel, props),
          }),
        'context-archive stats tab',
      )
    }

    return {
      name: 'dsh-context-archive',
      inject: ['betterSidebar'],
      apply,
    }
  },
})
