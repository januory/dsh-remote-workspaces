/**
 * Browser half of the SSH remote workspace plugin:
 *
 * 1. A "远程工作区" settings section — a multi-machine SSH registry (add /
 *    edit / delete / test) with `~/.ssh/config` as a one-click form-fill
 *    convenience.
 *
 * 2. A composed directory-flow picker registered into the harness's two
 *    workspace-add holes (`conversation.hero.workspace.directoryFlow` and
 *    `sidebar.workspaces.directoryFlow`) at a lower priority so it shadows the
 *    native chooser and offers BOTH "本地文件夹" and "远程目录".
 *
 * 3. A "Shell" tab type (kind `shell`, guide entry on the 开始/Start page)
 *    whose body renders a real xterm terminal backed by a local PTY session.
 *
 * Built by `scripts/build-client.mjs` (esbuild) into `lib/client.js`: the
 * bundle registers `window.__ModuleLoader__.load({id, factory})`, keeps `react`
 * as a platform seed word (resolved by the factory's injected `require`), and
 * INLINES `@xterm/xterm` + its CSS. `exports["./client"]` points at the built
 * artifact, so no deepseek-harness source is modified.
 */

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import xtermCss from '@xterm/xterm/css/xterm.css'

var React = require('react')

// ---------------------------------------------------------------------------
// Remote contract (must match src/index.js). Parameters carry strict codecs
// with a pass-through `parse` (the client `$mount` face rejects `src-json`).
// ---------------------------------------------------------------------------
var PACKAGE = 'dsh-remote-workspaces'
var NAMESPACE = 'remoteWorkspaces'

var JSON_CODEC = Object.freeze({
  mode: 'strict',
  typeSymbol: 'JsonValue',
  schema: Object.freeze({
    parse: function (value) { return value },
  }),
})

function jsonParameter(name) {
  return { name: name, wire: name, source: 'json', codec: JSON_CODEC }
}

function invocation(method, parameters) {
  return {
    id: NAMESPACE + '/' + method,
    service: NAMESPACE,
    namespace: NAMESPACE,
    method: method,
    invocation: { kind: 'direct' },
    parameters: parameters || [],
    result: JSON_CODEC,
  }
}

var INVOCATIONS = [
  invocation('listMachines'),
  invocation('saveMachine', [jsonParameter('machine')]),
  invocation('deleteMachine', [jsonParameter('id')]),
  invocation('listSshAliases'),
  invocation('sshAliasDetail', [jsonParameter('alias')]),
  invocation('testConnection', [jsonParameter('machine')]),
  invocation('listRemoteDir', [jsonParameter('machine'), jsonParameter('path')]),
  invocation('openRemoteWorkspace', [jsonParameter('machine'), jsonParameter('path')]),
  invocation('openShellLocal', [jsonParameter('opts')]),
  invocation('openShellRemote', [jsonParameter('machine'), jsonParameter('opts')]),
  invocation('openShellAt', [jsonParameter('cwd'), jsonParameter('opts')]),
  invocation('shellWrite', [jsonParameter('id'), jsonParameter('data')]),
  invocation('shellRead', [jsonParameter('id')]),
  invocation('shellResize', [jsonParameter('id'), jsonParameter('rows'), jsonParameter('cols')]),
  invocation('shellClose', [jsonParameter('id')]),
  invocation('shellList'),
]

function unwrapRemote(res) {
  if (res === undefined || res === null) return { ok: false, error: '无响应' }
  if (res.ok === false) {
    var e = res.error
    return { ok: false, error: e && e.message ? e.message : '调用失败' }
  }
  return res.value || { ok: false, error: '空结果' }
}

    var sectionStyle = { padding: 16, fontSize: 14, lineHeight: 1.6, maxWidth: 820, color: 'inherit' }
    var labelStyle = { color: '#8b8f98', margin: 0, fontSize: 12.5 }
    var monoStyle = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5 }
    // Control styling mirrors the "网关接入 → 查询状态" button (plugins/
    // dsh-gateway-agent): neutral translucent surfaces + `color: inherit` so the
    // text follows the host theme in both dark and light themes. The primary
    // button is a fixed brand fill, matching the reference's S.primary.
    var btnStyle = {
      padding: '7px 14px', fontSize: 13.5, cursor: 'pointer',
      background: 'rgba(127,127,127,0.12)', color: 'inherit',
      border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6, whiteSpace: 'nowrap',
    }
    var mobileBtnStyle = {
      padding: '11px 14px', fontSize: 14, cursor: 'pointer',
      background: 'rgba(127,127,127,0.12)', color: 'inherit',
      border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6, minHeight: 44, whiteSpace: 'nowrap',
    }
    var btnPrim = {
      padding: '7px 14px', fontSize: 13.5, cursor: 'pointer',
      background: '#6e56cf', color: '#fff', border: '1px solid transparent',
      borderRadius: 6, fontWeight: 600, whiteSpace: 'nowrap',
    }
    var btnPrimMob = {
      padding: '11px 14px', fontSize: 14, cursor: 'pointer',
      background: '#6e56cf', color: '#fff', border: '1px solid transparent',
      borderRadius: 6, fontWeight: 600, minHeight: 44, whiteSpace: 'nowrap',
    }
    var btnDanger = {
      padding: '7px 14px', fontSize: 13.5, cursor: 'pointer',
      background: '#e5484d', color: '#fff', border: '1px solid transparent',
      borderRadius: 6, fontWeight: 600, whiteSpace: 'nowrap',
    }
    var btnDangerMob = {
      padding: '11px 14px', fontSize: 14, cursor: 'pointer',
      background: '#e5484d', color: '#fff', border: '1px solid transparent',
      borderRadius: 6, fontWeight: 600, minHeight: 44, whiteSpace: 'nowrap',
    }
    var inputStyle = {
      padding: '7px 10px', fontSize: 13.5, width: '100%', boxSizing: 'border-box',
      background: 'rgba(127,127,127,0.08)', color: 'inherit',
      border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6,
    }
    var mobileInputStyle = {
      padding: '9px 12px', fontSize: 16, width: '100%', boxSizing: 'border-box', minHeight: 44,
      background: 'rgba(127,127,127,0.08)', color: 'inherit',
      border: '1px solid rgba(127,127,127,0.3)', borderRadius: 6,
    }
    var mobileSectionStyle = { padding: 12, fontSize: 14, lineHeight: 1.6, color: 'inherit' }
    var dangerColor = '#e5484d'
    var successColor = '#46a758'
    var borderColor = 'rgba(127,127,127,0.3)'
    var modalBg = '#1f1f21'
    var modalText = '#e8e8e8'
    var chipStyle = { display: 'inline-block', padding: '1px 8px', borderRadius: 10, background: 'rgba(127,127,127,0.18)', fontSize: 11.5, lineHeight: '18px', color: 'inherit' }

    // Detect a narrow (mobile) viewport so the UI can switch to a stacked,
    // larger-touch-target layout. Pure clickable hooks; no CSS build step.
    function useIsMobile() {
      var state = React.useState(false)
      var matches = state[0]
      var setMatches = state[1]
      React.useEffect(function () {
        if (typeof window === 'undefined' || !window.matchMedia) return
        var mq = window.matchMedia('(max-width: 640px)')
        function onChange(e) { setMatches(e.matches) }
        setMatches(mq.matches)
        if (mq.addEventListener) mq.addEventListener('change', onChange)
        else if (mq.addListener) mq.addListener(onChange)
        return function () {
          if (mq.removeEventListener) mq.removeEventListener('change', onChange)
          else if (mq.removeListener) mq.removeListener(onChange)
        }
      }, [])
      return matches
    }

    function pathBasename(p) {
      if (!p) return ''
      var s = String(p).replace(/[\\/]+$/, '')
      var idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
      return idx >= 0 ? s.slice(idx + 1) : s
    }

    // =========================================================================
    // Settings section: machine registry only (no remote browsing).
    // =========================================================================
    function SshWorkspaceSection(props) {
      var getRemote = props.getRemote
      var mount = props.mount

      var machinesState = React.useState([])
      var machines = machinesState[0]
      var setMachines = machinesState[1]
      var loadingState = React.useState(true)
      var loading = loadingState[0]
      var setLoading = loadingState[1]
      var errorState = React.useState(null)
      var error = errorState[0]
      var setError = errorState[1]
      var remoteState = React.useState(null)
      var remote = remoteState[0]
      var setRemote = remoteState[1]
      var mountErrorState = React.useState(null)
      var mountError = mountErrorState[0]
      var setMountError = mountErrorState[1]
      var formState = React.useState(null)
      var form = formState[0]
      var setForm = formState[1]
      var aliasesState = React.useState(null)
      var aliases = aliasesState[0]
      var setAliases = aliasesState[1]
      var showAliasesState = React.useState(false)
      var showAliases = showAliasesState[0]
      var setShowAliases = showAliasesState[1]
      var resultsState = React.useState({})
      var results = resultsState[0]
      var setResults = resultsState[1]
      var expandedHostsState = React.useState({})
      var expandedHosts = expandedHostsState[0]
      var setExpandedHosts = expandedHostsState[1]
      var deleteTargetState = React.useState(null)
      var deleteTarget = deleteTargetState[0]
      var setDeleteTarget = deleteTargetState[1]
      var deletingState = React.useState(false)
      var deleting = deletingState[0]
      var setDeleting = deletingState[1]
      var isMobile = useIsMobile()

      React.useEffect(function () {
        var alive = true
        mount.then(
          function () {
            if (!alive) return
            var ns = getRemote()
            setRemote(ns)
            ns.listMachines().then(
              function (res) {
                var b = unwrapRemote(res)
                if (!alive) return
                if (b.ok) setMachines(b.machines || [])
                else setError(b.error || '加载主机失败')
                setLoading(false)
              },
              function (err) {
                if (!alive) return
                setError(err && err.message ? err.message : String(err))
                setLoading(false)
              },
            )
          },
          function (err) { if (alive) setMountError(err && err.message ? err.message : String(err)) },
        )
        return function () { alive = false }
      }, [])

      function refreshMachines() {
        setLoading(true)
        setError(null)
        remote.listMachines().then(
          function (res) {
            var b = unwrapRemote(res)
            setLoading(false)
            if (b.ok) setMachines(b.machines || [])
            else setError(b.error || '加载主机失败')
          },
          function (err) {
            setLoading(false)
            setError(err && err.message ? err.message : String(err))
          },
        )
      }

      function openNew() {
        setForm({ isNew: true, machine: { id: undefined, alias: '', host: '', port: '', user: '', identityFile: '', hasPassword: false } })
      }
      function openEdit(machine) { setForm({ isNew: false, machine: machine }) }
      function closeForm() { setForm(null) }

      function doSave(values) {
        var payload = {
          id: form.isNew ? undefined : form.machine.id,
          alias: values.alias,
          host: values.host,
          port: values.port,
          user: values.user,
          identityFile: values.identityFile,
          password: values.password === '' ? undefined : values.password,
          passphrase: values.passphrase === '' ? undefined : values.passphrase,
        }
        remote.saveMachine(payload).then(
          function (res) {
            var b = unwrapRemote(res)
            if (b.ok) { closeForm(); refreshMachines() }
            else setError(b.error || '保存失败')
          },
          function (err) { setError(err && err.message ? err.message : String(err)) },
        )
      }

      function doDelete(machine) {
        setDeleteTarget(machine)
      }

      function closeDelete() {
        if (!deleting) setDeleteTarget(null)
      }

      function confirmDelete() {
        if (!remote || !deleteTarget || deleting) return
        setDeleting(true)
        var machine = deleteTarget
        remote.deleteMachine(machine.id).then(
          function () {
            setDeleting(false)
            setDeleteTarget(null)
            refreshMachines()
          },
          function (err) {
            setDeleting(false)
            setError(err && err.message ? err.message : String(err))
          },
        )
      }

      function doTest(machine) {
        var key = machine.id
        setResults(function (prev) { var next = Object.assign({}, prev); next[key] = { testing: true }; return next })
        remote.testConnection(machine).then(
          function (res) {
            setResults(function (prev) { var next = Object.assign({}, prev); next[key] = unwrapRemote(res); return next })
          },
          function (err) {
            setResults(function (prev) {
              var next = Object.assign({}, prev)
              next[key] = { ok: false, error: err && err.message ? err.message : String(err) }
              return next
            })
          },
        )
      }

      function toggleAliases() {
        var next = !showAliases
        setShowAliases(next)
        if (next && aliases === null) {
          remote.listSshAliases().then(
            function (res) {
              var b = unwrapRemote(res)
              if (b.ok) setAliases(b.aliases || [])
              else setAliases([])
            },
            function () { setAliases([]) },
          )
        }
      }

      function fillFromAlias(alias) {
        remote.sshAliasDetail(alias).then(
          function (res) {
            var b = unwrapRemote(res)
            if (b.ok) setForm({ isNew: true, machine: b.machine })
            else setError(b.error || '读取别名失败')
          },
          function (err) { setError(err && err.message ? err.message : String(err)) },
        )
      }

      function toggleHost(id) {
        setExpandedHosts(function (prev) {
          var n = Object.assign({}, prev)
          n[id] = prev[id] === false // default open → first click collapses
          return n
        })
      }

      return React.createElement(
        'div',
        { className: 'dsh-rw-btn', style: isMobile ? mobileSectionStyle : sectionStyle },
        React.createElement('div', { style: { fontWeight: 600, fontSize: 16, marginBottom: 8 } }, '远程工作区'),
        React.createElement('p', { style: { margin: '0 0 12px' } },
          '管理 SSH 主机与已打开的远程工作区。添加远程工作区请在侧边栏「添加工作区」里选「远程目录」。'),
        mountError !== null
          ? React.createElement('p', { style: { color: dangerColor, margin: '0 0 12px' } }, 'Remote 命名空间挂载失败：' + mountError)
          : null,
        error !== null
          ? React.createElement('p', { style: { color: dangerColor, margin: '0 0 12px' } }, error)
          : null,
        React.createElement('div', { style: Object.assign({ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }, isMobile ? { flexDirection: 'column' } : {}) },
          React.createElement('button', { type: 'button', onClick: openNew, disabled: !remote, style: Object.assign({}, btnPrim, isMobile ? btnPrimMob : {}) }, '添加主机'),
          React.createElement('button', { type: 'button', onClick: toggleAliases, disabled: !remote, style: Object.assign({}, btnStyle, isMobile ? mobileBtnStyle : {}) }, '从 ~/.ssh/config 导入'),
        ),
        showAliases
          ? React.createElement('div', { style: { border: '1px solid ' + borderColor, borderRadius: 6, padding: 10, marginBottom: 12 } },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, '选择要填充到表单的别名'),
              aliases === null
                ? React.createElement('div', { style: labelStyle }, '读取中…')
                : aliases.length === 0
                  ? React.createElement('div', { style: labelStyle }, '未找到 ~/.ssh/config 或其中没有 Host 别名')
                  : React.createElement('div', {},
                      aliases.map(function (alias) {
                        return React.createElement('span', { key: alias, onClick: function () { fillFromAlias(alias) }, style: Object.assign({}, monoStyle, { display: 'inline-block', padding: '3px 8px', margin: '0 6px 6px 0', border: '1px solid ' + borderColor, borderRadius: 4, cursor: 'pointer' }) }, alias)
                      }),
                    ),
            )
          : null,
        form !== null
          ? React.createElement(FormPanel, { key: (form.machine.alias || '') + '|' + (form.machine.host || '') + '|' + (form.machine.id || 'new'), form: form, onSave: doSave, onCancel: closeForm })
          : null,
        loading
          ? React.createElement('div', { style: labelStyle }, '加载中…')
          : machines.length === 0
            ? React.createElement('div', { style: labelStyle }, '还没有主机，点「添加主机」配置一台。')
            : React.createElement('div', { style: { marginTop: 4 } },
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
                  React.createElement('div', { style: { fontWeight: 600 } }, '主机（' + machines.length + '）'),
                ),
                machines.map(function (machine) {
                  var open = expandedHosts[machine.id] !== false
                  return MachineRow(
                    machine,
                    results[machine.id],
                    open,
                    function () { toggleHost(machine.id) },
                    function () { doTest(machine) },
                    function () { openEdit(machine) },
                    function () { doDelete(machine) },
                    isMobile,
                  )
                }),
              ),
        deleteTarget !== null
          ? React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: 16 } },
              React.createElement('div', { style: { background: modalBg, border: '1px solid ' + borderColor, borderRadius: 8, padding: isMobile ? 14 : 16, width: 440, maxWidth: '100%', color: modalText } },
                React.createElement('div', { style: { fontWeight: 600, fontSize: 15, marginBottom: 10 } }, '删除主机'),
                React.createElement('p', { style: { margin: '0 0 12px', lineHeight: 1.6 } },
                  '确定删除主机「' + (deleteTarget.alias || deleteTarget.host) + '」吗？（远端数据不受影响）'),
                React.createElement('div', { style: Object.assign({ display: 'flex', gap: 8, justifyContent: 'flex-end' }, isMobile ? { flexDirection: 'column' } : {}) },
                  React.createElement('button', { type: 'button', onClick: closeDelete, disabled: deleting, style: Object.assign({}, btnStyle, isMobile ? mobileBtnStyle : {}) }, '取消'),
                  React.createElement('button', { type: 'button', onClick: confirmDelete, disabled: deleting, style: isMobile ? btnDangerMob : btnDanger }, deleting ? '删除中…' : '删除'),
                ),
              ),
            )
          : null,
      )
    }

    function MachineRow(machine, result, open, onToggle, onTest, onEdit, onDelete, isMobile) {
      var summary = [machine.alias || '(未命名)']
      if (machine.host) summary.push(machine.host)
      if (machine.user) summary.push('@' + machine.user)
      if (machine.port) summary.push(':' + machine.port)
      var mobileBtn = isMobile ? Object.assign({}, mobileBtnStyle) : btnStyle
      var dangerBtn = isMobile ? btnDangerMob : btnDanger
      function action(label, handler, style) {
        return React.createElement('button', { type: 'button', onClick: function (e) { e.stopPropagation(); handler() }, style: style }, label)
      }
      var testBtn = action('测试连接', onTest, mobileBtn)
      var editBtn = action('编辑', onEdit, mobileBtn)
      var deleteBtn = action('删除', onDelete, dangerBtn)
      return React.createElement(
        'div',
        { style: { borderTop: '1px solid ' + borderColor, padding: '8px 0' } },
        React.createElement('div', { onClick: onToggle, style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
          React.createElement('span', { style: { color: '#8b8f98', width: 16, flexShrink: 0 } }, open ? '▾' : '▸'),
          React.createElement('span', { style: Object.assign({}, monoStyle, { fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }, summary.join(' ')),
          React.createElement('span', { style: { flex: 1 } }),
          isMobile ? null : testBtn,
          isMobile ? null : editBtn,
          isMobile ? null : deleteBtn,
        ),
        isMobile
          ? React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6, paddingLeft: 24, flexWrap: 'wrap' } }, testBtn, editBtn, deleteBtn)
          : null,
        React.createElement('div', { style: { display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap', paddingLeft: 24 } },
          machine.identityFile
            ? React.createElement('span', { title: '私钥：' + machine.identityFile, style: chipStyle }, '私钥 ' + pathBasename(machine.identityFile))
            : null,
          machine.hasPassword
            ? React.createElement('span', { title: '登录密码已保存在本地', style: chipStyle }, '密码已保存')
            : null,
          machine.hasPassphrase
            ? React.createElement('span', { title: '私钥口令已保存在本地，连接时会自动使用', style: chipStyle }, '口令已保存')
            : null,
        ),
        result && result.testing
          ? React.createElement('div', { style: Object.assign({}, labelStyle, { paddingLeft: 24, marginTop: 2 }) }, '测试中…')
          : result && result.ok === true
            ? React.createElement('div', { style: { color: successColor, margin: 0, paddingLeft: 24, marginTop: 2 } }, '已连接（' + result.ms + 'ms）')
            : result
              ? React.createElement('div', { style: { color: dangerColor, margin: 0, paddingLeft: 24, marginTop: 2 } }, result.error || '连接失败')
              : null,
      )
    }

    function FormPanel(props) {
      var initial = props.form.machine || {}
      var valuesState = React.useState({
        alias: initial.alias || '',
        host: initial.host || '',
        port: initial.port || '',
        user: initial.user || '',
        identityFile: initial.identityFile || '',
        password: '',
        passphrase: '',
      })
      var values = valuesState[0]
      var setValues = valuesState[1]
      var isMobile = useIsMobile()

      function set(field) {
        return function (e) {
          var next = Object.assign({}, values)
          next[field] = e.target.value
          setValues(next)
        }
      }

      function submit(e) {
        e.preventDefault()
        props.onSave(values)
      }

      function field(label, name, type, placeholder) {
        return React.createElement('div', { style: { marginBottom: 8 } },
          React.createElement('div', { style: labelStyle }, label),
          React.createElement('input', { type: type || 'text', value: values[name], onChange: set(name), placeholder: placeholder || '', style: isMobile ? mobileInputStyle : inputStyle }),
        )
      }

      var formBtn = isMobile ? mobileBtnStyle : btnStyle
      var formBtnPrim = isMobile ? btnPrimMob : btnPrim
      return React.createElement(
        'form',
        { onSubmit: submit, style: { border: '1px solid ' + borderColor, borderRadius: 6, padding: isMobile ? 10 : 12, marginBottom: 12 } },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, props.form.isNew ? '添加主机' : '编辑主机'),
        field('别名（alias）', 'alias', 'text', '如 dev'),
        field('主机地址（host）', 'host', 'text', '如 192.168.1.10 或 example.com'),
        field('端口（port）', 'port', 'number', '默认 22'),
        field('用户名（user）', 'user', 'text', '默认当前用户'),
        field('私钥路径（identityFile）', 'identityFile', 'text', '如 ~/.ssh/id_rsa，留空用默认密钥'),
        field('密码（password）', 'password', 'password', props.form.isNew ? '可选' : '留空保持不变，输入则替换'),
        field('私钥口令（passphrase）', 'passphrase', 'password', props.form.isNew ? '可选' : '留空保持不变'),
        React.createElement('div', { style: Object.assign({ display: 'flex', gap: 8, marginTop: 4 }, isMobile ? { flexDirection: 'column' } : {}) },
          React.createElement('button', { type: 'submit', style: formBtnPrim }, '保存'),
          React.createElement('button', { type: 'button', onClick: props.onCancel, style: formBtn }, '取消'),
        ),
      )
    }

    // =========================================================================
    // Composed directory-flow picker (workspace add): local + remote.
    // =========================================================================
    function joinPosix(base, name) {
      if (base === '' || base === undefined || base === null) return name
      if (base === '/') return '/' + name
      return base.replace(/\/+$/, '') + '/' + name
    }

    function parentPosix(path) {
      if (path === '' || path === undefined || path === null || path === '/') return '/'
      var s = path.replace(/\/+$/, '')
      if (s === '') return '/'
      var idx = s.lastIndexOf('/')
      return idx <= 0 ? '/' : s.slice(0, idx)
    }

    // One remote directory/file row: directories render first with a folder
    // icon and are clickable; files render below with a muted style.
    function EntryRow(props) {
      var entry = props.entry
      var onOpen = props.onOpen
      var hoverState = React.useState(false)
      var hover = hoverState[0]
      var setHover = hoverState[1]
      var rowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 8px',
        borderRadius: 4,
        cursor: entry.dir ? 'pointer' : 'default',
        background: hover ? 'rgba(127,127,127,0.16)' : 'transparent',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        color: entry.dir ? 'inherit' : 'rgba(232,232,232,0.55)',
      }
      return React.createElement(
        'div',
        {
          style: rowStyle,
          onClick: entry.dir ? function () { onOpen(entry.name) } : undefined,
          onMouseEnter: function () { setHover(true) },
          onMouseLeave: function () { setHover(false) },
          title: entry.dir ? entry.name + '/' : entry.name,
        },
        React.createElement('span', { style: { width: 18, textAlign: 'center', flexShrink: 0 } }, entry.dir ? '📁' : '📄'),
        React.createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.name),
        entry.dir ? React.createElement('span', { style: { color: '#8b8f98', flexShrink: 0 } }, '/') : null,
      )
    }

    function RemoteDirectoryFlow(props) {
      var open = props.open
      var busy = props.busy
      var onPicked = props.onPicked
      var onCancel = props.onCancel
      var onError = props.onError
      var getRemote = props.getRemote
      var pickLocal = props.pickLocal

      var modeState = React.useState('remote')
      var mode = modeState[0]
      var setMode = modeState[1]
      var machinesState = React.useState([])
      var machines = machinesState[0]
      var setMachines = machinesState[1]
      var machinesLoadedState = React.useState(false)
      var machinesLoaded = machinesLoadedState[0]
      var setMachinesLoaded = machinesLoadedState[1]
      var selectedState = React.useState(null)
      var selected = selectedState[0]
      var setSelected = selectedState[1]
      var browseState = React.useState(null)
      var browse = browseState[0]
      var setBrowse = browseState[1]
      var openingState = React.useState(false)
      var opening = openingState[0]
      var setOpening = openingState[1]
      var localPickingState = React.useState(false)
      var localPicking = localPickingState[0]
      var setLocalPicking = localPickingState[1]
      var pathInputState = React.useState('')
      var pathInput = pathInputState[0]
      var setPathInput = pathInputState[1]
      var isMobile = useIsMobile()

      // Reset per open edge, then load machines.
      React.useEffect(function () {
        if (!open) return
        setMode('remote')
        setMachines([])
        setMachinesLoaded(false)
        setSelected(null)
        setBrowse(null)
        setOpening(false)
        setLocalPicking(false)
        var ns = getRemote()
        if (!ns) return
        ns.listMachines().then(
          function (res) {
            var b = unwrapRemote(res)
            if (b.ok) setMachines(b.machines || [])
            setMachinesLoaded(true)
          },
          function () { setMachinesLoaded(true) },
        )
      }, [open])

      // Keep the path input in sync with the browsed directory (but not while
      // the user is editing it).
      React.useEffect(function () {
        if (browse && browse.path !== undefined && browse.path !== null) setPathInput(browse.path)
        else setPathInput('')
      }, [browse && browse.path])

      function pickMachine(machine) {
        setSelected(machine)
        setBrowse(null)
        loadEntries(machine, '')
      }

      function loadEntries(machine, path) {
        setBrowse({ machine: machine, path: path, loading: true, error: null, entries: [] })
        getRemote().listRemoteDir(machine, path).then(
          function (res) {
            var b = unwrapRemote(res)
            setBrowse(function (prev) {
              if (!prev || prev.machine !== machine) return prev
              if (b.ok) {
                // The host returns the resolved absolute path (home expanded),
                // so "上一级" can walk past home all the way up to `/`.
                var resolved = b.path !== undefined && b.path !== null && b.path !== '' ? b.path : path
                return { machine: machine, path: resolved, loading: false, error: null, entries: b.entries || [] }
              }
              return { machine: machine, path: path, loading: false, error: b.error || '列出目录失败', entries: [] }
            })
          },
          function (err) {
            setBrowse(function (prev) {
              if (!prev || prev.machine !== machine) return prev
              return { machine: machine, path: path, loading: false, error: err && err.message ? err.message : String(err), entries: [] }
            })
          },
        )
      }

      function navigate(name) {
        loadEntries(browse.machine, joinPosix(browse.path, name))
      }
      function goUp() {
        if (!browse || !browse.path) return
        var parent = parentPosix(browse.path)
        if (parent === browse.path) return
        loadEntries(browse.machine, parent)
      }
      function jumpTo() {
        if (!selected) return
        loadEntries(selected, pathInput)
      }

      function doLocal() {
        if (localPicking) return
        setLocalPicking(true)
        pickLocal().then(
          function (path) {
            if (path === null || path === undefined || path === '') onCancel()
            else onPicked(path)
          },
          function (err) {
            onError(err && err.message ? err.message : String(err))
          },
        )
      }

      function doOpenRemote() {
        if (opening || !selected || !browse) return
        setOpening(true)
        getRemote().openRemoteWorkspace(selected, browse.path).then(
          function (res) {
            var b = unwrapRemote(res)
            if (b.ok && b.localDir) onPicked(b.localDir)
            else onError(b.error || '打开远程工作区失败')
          },
          function (err) { onError(err && err.message ? err.message : String(err)) },
        )
      }

      if (!open) return null

      return React.createElement(
        'div',
        { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 } },
        React.createElement(
          'div',
          { className: 'dsh-rw-btn', style: { background: modalBg, border: '1px solid ' + borderColor, borderRadius: 8, padding: isMobile ? 14 : 16, width: 560, maxWidth: '92vw', maxHeight: '82vh', overflow: 'auto', color: modalText } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 12 } },
            React.createElement('span', { style: { fontWeight: 600, fontSize: 15 } }, '打开文件夹'),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('button', { type: 'button', onClick: onCancel, style: isMobile ? mobileBtnStyle : btnStyle }, '取消'),
          ),
          React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 12 } },
            React.createElement('button', { type: 'button', onClick: function () { setMode('local') }, style: Object.assign({}, btnStyle, isMobile ? { flex: 1 } : {}, isMobile ? mobileBtnStyle : {}, mode === 'local' ? { background: '#6e56cf', color: '#fff', border: '1px solid transparent' } : {}) }, '本地文件夹'),
            React.createElement('button', { type: 'button', onClick: function () { setMode('remote') }, style: Object.assign({}, btnStyle, isMobile ? { flex: 1 } : {}, isMobile ? mobileBtnStyle : {}, mode === 'remote' ? { background: '#6e56cf', color: '#fff', border: '1px solid transparent' } : {}) }, '远程目录'),
          ),
          mode === 'local'
            ? React.createElement('div', {},
                React.createElement('p', { style: { margin: '0 0 12px' } }, '在本机打开系统文件夹选择器，选取一个本地目录作为工作区。'),
                React.createElement('button', { type: 'button', onClick: doLocal, disabled: localPicking || busy, style: Object.assign({}, btnStyle, isMobile ? { width: '100%' } : {}, isMobile ? mobileBtnStyle : {}) }, localPicking ? '等待选择…' : '选择本地文件夹'),
              )
            : React.createElement('div', {},
                React.createElement('div', { style: { marginBottom: 8 } }, '选择 SSH 主机（在「设置 → 远程工作区」中配置）：'),
                machinesLoaded && machines.length === 0
                  ? React.createElement('div', { style: { color: dangerColor, margin: '0 0 8px' } }, '还没有配置主机，请先到「设置 → 远程工作区」添加。')
                  : React.createElement('select', {
                      value: selected ? selected.id : '',
                      onChange: function (e) {
                        var id = e.target.value
                        var m = machines.find(function (x) { return x.id === id })
                        if (m) pickMachine(m)
                      },
                      style: Object.assign({}, isMobile ? mobileInputStyle : inputStyle, { marginBottom: 8 }),
                    },
                      React.createElement('option', { value: '' }, '选择主机…'),
                      machines.map(function (m) {
                        return React.createElement('option', { key: m.id, value: m.id }, (m.alias || m.host) + ' (' + m.host + (m.user ? '@' + m.user : '') + ')')
                      }),
                    ),
                selected
                  ? React.createElement('div', { style: { border: '1px solid ' + borderColor, borderRadius: 6, padding: 10 } },
                      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
                        React.createElement('input', {
                          type: 'text',
                          value: pathInput,
                          onChange: function (e) { setPathInput(e.target.value) },
                          onKeyDown: function (e) { if (e.key === 'Enter') jumpTo() },
                          placeholder: '输入绝对路径，或 ~ 回到主目录',
                          spellCheck: false,
                          style: Object.assign({}, monoStyle, isMobile
                            ? { flex: '1 1 100%', minWidth: 0, padding: '9px 8px', fontSize: 16, boxSizing: 'border-box' }
                            : { flex: 1, minWidth: 0, padding: '5px 8px', fontSize: 13, boxSizing: 'border-box' }),
                        }),
                        React.createElement('button', { type: 'button', onClick: jumpTo, disabled: !browse || browse.loading, style: Object.assign({}, btnStyle, isMobile ? { flex: 1 } : {}, isMobile ? mobileBtnStyle : {}) }, '跳转'),
                        React.createElement('button', { type: 'button', onClick: goUp, disabled: !browse || browse.loading || !browse.path || browse.path === '/', style: Object.assign({}, btnStyle, isMobile ? { flex: 1 } : {}, isMobile ? mobileBtnStyle : {}) }, '上一级'),
                      ),
                      browse && browse.loading
                        ? React.createElement('div', { style: labelStyle }, '加载中…')
                        : browse && browse.error
                          ? React.createElement('div', { style: { color: dangerColor, margin: 0 } }, browse.error)
                          : browse
                            ? React.createElement('div', { style: { maxHeight: 220, overflow: 'auto', border: '1px solid ' + borderColor, borderRadius: 6 } },
                                (browse.entries || []).slice().sort(function (a, b) {
                                  if (a.dir !== b.dir) return a.dir ? -1 : 1
                                  var an = a.name.toLowerCase()
                                  var bn = b.name.toLowerCase()
                                  return an < bn ? -1 : an > bn ? 1 : 0
                                }).map(function (e) {
                                  return React.createElement(EntryRow, { key: (e.dir ? 'd:' : 'f:') + e.name, entry: e, onOpen: navigate })
                                }),
                              )
                            : null,
                      React.createElement('div', { style: { marginTop: 10 } },
                        React.createElement('button', { type: 'button', onClick: doOpenRemote, disabled: opening || busy || (browse && browse.loading), style: Object.assign({}, btnPrim, isMobile ? { width: '100%' } : {}, isMobile ? btnPrimMob : {}) },
                          opening ? '打开中…' : '打开此目录'),
                      ),
                    )
                  : null,
              ),
        ),
      )
    }

    // =========================================================================
    // Shell tab: a real xterm terminal opened directly AT the current workspace
    // cwd — no local/remote chooser. The host resolves the cwd to a local PTY
    // or to a remote shell channel on the matching anchor machine.
    //
    // A shell session is KEPT ALIVE across session switches: the tab body
    // unmounts when its session leaves the screen but its occurrence signal is
    // NOT aborted, so the host session persists and the next mount re-attaches
    // to it (no reconnect, no "连接中").
    // =========================================================================
    var shellSessionCache = {}

    function ShellBody(props) {
      var getRemote = props.getRemote
      var getCwd = props.getCwd
      var getSessionId = props.getSessionId
      var useTabInfo = props.useTabInfo
      return React.createElement(TerminalPane, { getRemote: getRemote, getCwd: getCwd, getSessionId: getSessionId, useTabInfo: useTabInfo })
    }

    function TerminalPane(props) {
      var getRemote = props.getRemote
      var getCwd = props.getCwd
      var getSessionId = props.getSessionId
      var useTabInfo = props.useTabInfo
      var info = useTabInfo ? useTabInfo() : null
      var tabSignal = info ? info.tab.signal : null
      var tabId = info && info.tab ? info.tab.id : 'shell'
      var containerRef = React.useRef(null)
      var termRef = React.useRef(null)
      var sessionRef = React.useRef(null)
      var kindRef = React.useRef(null)
      var timerRef = React.useRef(null)
      var statusState = React.useState('connecting')
      var status = statusState[0]
      var setStatus = statusState[1]
      var errState = React.useState(null)
      var err = errState[0]
      var setErr = errState[1]
      var labelState = React.useState('终端')
      var label = labelState[0]
      var setLabel = labelState[1]

      React.useEffect(function () {
        var disposed = false
        var el = containerRef.current
        if (!el) return undefined

        var fg = resolveShellFg()

        var term = new Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          scrollback: 2000,
          convertEol: false,
          allowTransparency: true,
          theme: { background: 'transparent', foreground: fg, cursor: fg, cursorAccent: 'transparent' },
        })
        var fitAddon = new FitAddon()
        term.loadAddon(fitAddon)
        termRef.current = term
        term.open(el)
        term.focus()

        // Follow theme switches (dark <-> light): the pane background is
        // transparent, so the foreground must re-resolve or light-mode text
        // turns white-on-white.
        var themeObserver = null
        if (typeof MutationObserver !== 'undefined' && document.body) {
          themeObserver = new MutationObserver(function () {
            if (disposed) return
            var next = resolveShellFg()
            try { term.options.theme = { background: 'transparent', foreground: next, cursor: next, cursorAccent: 'transparent' } } catch (e2) { /* noop */ }
          })
          themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        }

        var ns = getRemote()
        if (!ns) {
          setStatus('error')
          setErr('Remote 命名空间未就绪')
          term.writeln('\x1b[31m[shell] Remote 命名空间未就绪\x1b[0m')
          return undefined
        }

        // Stable per-(session, tab) key derived from the session id + the dock
        // tab id. Both survive a page refresh (the session is resumed and the
        // layout restores the tab id), so a re-mount — or a re-load — re-attaches
        // to the same host session instead of reconnecting or leaking a new one.
        var key = (getSessionId ? getSessionId() : 's') + ':' + tabId

        var opened = false
        var ro = null
        var rafId = 0
        var resizePending = false

        function openWithFittedSize() {
          if (disposed || opened) return
          opened = true
          if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
          try { fitAddon.fit() } catch (e) { /* keep default rows/cols */ }
          var cached = shellSessionCache[key]
          if (cached && cached.id) {
            // Re-attaching to a kept-alive session: show connected at once,
            // and the full scrollback replays when the attach resolves below.
            setLabel(cached.label || '本机')
            setStatus('open')
          }
          var opts = { rows: term.rows, cols: term.cols, key: key }
          var cwd = getCwd ? getCwd() : undefined
          ns.openShellAt(cwd, opts).then(
            function (res) {
              if (disposed) return
              var b = unwrapRemote(res)
              if (!b.ok) {
                setStatus('error')
                setErr(b.error || '打开失败')
                term.writeln('\x1b[31m[shell] ' + (b.error || '打开失败') + '\x1b[0m')
                return
              }
              // Attach replays the capped scrollback so the terminal is not blank.
              if (b.attached && b.history) term.write(b.history)
              sessionRef.current = b.id
              kindRef.current = b.kind || null
              setLabel(b.label || (b.kind === 'remote' ? '远程' : '本机'))
              setStatus('open')
              shellSessionCache[key] = { id: b.id, kind: b.kind || null, label: b.label || (b.kind === 'remote' ? '远程' : '本机') }
              timerRef.current = setTimeout(tick, 60)
            },
            function (e) {
              if (disposed) return
              setStatus('error')
              setErr(e && e.message ? e.message : String(e))
              term.writeln('\x1b[31m[shell] ' + (e && e.message ? e.message : String(e)) + '\x1b[0m')
            },
          )
        }

        function tick() {
          if (disposed) return
          var id = sessionRef.current
          if (!id) return
          ns.shellRead(id).then(
            function (r) {
              if (disposed) return
              var out = unwrapRemote(r)
              if (out.ok) {
                if (out.text) term.write(out.text)
                if (out.eof) { endSession('会话已结束'); return }
              } else if (/session not found/.test(out.error || '')) {
                endSession('会话已结束')
                return
              }
              timerRef.current = setTimeout(tick, 60)
            },
            function () {
              if (disposed) return
              timerRef.current = setTimeout(tick, 60)
            },
          )
        }

        function endSession(msg) {
          if (disposed || sessionRef.current === null) return
          var id = sessionRef.current
          sessionRef.current = null
          if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
          term.writeln('\r\n\x1b[2m[shell] ' + msg + '\x1b[0m')
          setStatus('ended')
          delete shellSessionCache[key]
          if (id) ns.shellClose(id)
        }

        function scheduleFit() {
          if (disposed || !opened || sessionRef.current === null) return
          if (resizePending) return
          resizePending = true
          requestAnimationFrame(function () {
            resizePending = false
            if (disposed || !opened || sessionRef.current === null) return
            var beforeR = term.rows
            var beforeC = term.cols
            try { fitAddon.fit() } catch (e) { /* noop */ }
            if (term.rows !== beforeR || term.cols !== beforeC) {
              var id = sessionRef.current
              if (kindRef.current === 'remote') ns.shellResize(id, term.rows, term.cols)
            }
          })
        }

        // Fit once when the flex chain gives real dimensions, then re-fit live
        // on resize. Remote sessions push the new rows/cols to the PTY via
        // setWindow; local sessions only re-fit the view (no seam resize — S0).
        if (typeof ResizeObserver !== 'undefined') {
          ro = new ResizeObserver(function (entries) {
            var r = entries[0] && entries[0].contentRect
            if (!r || r.height <= 0 || r.width <= 0) return
            if (opened) scheduleFit()
            else openWithFittedSize()
          })
          ro.observe(el)
        }
        var attempt = function () {
          if (disposed || opened) return
          if (el.clientHeight > 0 && el.clientWidth > 0) { openWithFittedSize(); return }
          rafId = requestAnimationFrame(attempt)
        }
        rafId = requestAnimationFrame(attempt)

        var dataDisposable = term.onData(function (data) {
          var id = sessionRef.current
          if (id && ns) ns.shellWrite(id, data)
        })

        return function () {
          disposed = true
          if (ro !== null) ro.disconnect()
          if (themeObserver !== null) themeObserver.disconnect()
          if (rafId) cancelAnimationFrame(rafId)
          if (timerRef.current) clearTimeout(timerRef.current)
          if (dataDisposable && dataDisposable.dispose) dataDisposable.dispose()
          var id = sessionRef.current
          // Close the host session only when the tab is genuinely removed
          // (occurrence signal aborted). A session switch unmounts the body
          // WITHOUT aborting, so the shell stays alive for the next re-attach.
          var removed = tabSignal ? tabSignal.aborted : true
          if (id && ns && removed) {
            delete shellSessionCache[key]
            ns.shellClose(id)
          }
          if (termRef.current) { try { termRef.current.dispose() } catch (e2) { /* noop */ } }
          termRef.current = null
          sessionRef.current = null
        }
      }, [])

      return React.createElement(
        'div',
        { className: 'dsh-rw-shell', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' } },
        React.createElement('div', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', borderBottom: '1px solid ' + borderColor, fontSize: 12, color: '#8b8f98' } },
          React.createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            status === 'open' ? label + ' · 已连接' : status === 'ended' ? label + ' · 已结束' : status === 'error' ? label + ' · 出错' : '连接中…'),
          React.createElement('button', {
            type: 'button',
            title: '新建 Shell',
            onClick: function () {
              try { if (info && info.tab && info.tab.actions) info.tab.actions.openTab(info.tab.kind, { revealIfOpened: false }) } catch (e2) { /* noop */ }
            },
            style: { padding: '2px 8px', fontSize: 11.5, cursor: 'pointer', background: 'rgba(127,127,127,0.12)', color: 'inherit', border: '1px solid rgba(127,127,127,0.3)', borderRadius: 4, whiteSpace: 'nowrap' },
          }, '＋ 新建'),
        ),
        err !== null
          ? React.createElement('div', { style: { flex: '0 0 auto', padding: '6px 10px', color: '#e5484d', fontFamily: 'ui-monospace, monospace', fontSize: 12, whiteSpace: 'pre-wrap' } }, err)
          : null,
        React.createElement('div', { ref: containerRef, style: { flex: 1, minHeight: 0, width: '100%' } }),
      )
    }

    // Terminal glyph for the 开始 page entry box (drawn at 16px; color rides currentColor).
    function ShellIcon(props) {
      var size = props && props.size ? props.size : 16
      return React.createElement('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        xmlns: 'http://www.w3.org/2000/svg',
      },
        React.createElement('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }),
        React.createElement('path', { d: 'M4.5 5.5 L7 8 L4.5 10.5' }),
        React.createElement('line', { x1: 8, y1: 10.5, x2: 11.5, y2: 10.5 }),
      )
    }

    // Foreground for the xterm: the theme's primary label color, with a
    // dark/light fallback. `--dsw-alias-label-primary` is dark in light mode
    // and light in dark mode; resolving it through a real DOM probe follows the
    // active theme exactly, while the attribute fallback keeps the shell
    // readable if the probe ever fails (or the token is unavailable).
    function resolveShellFg() {
      var dark = false
      try { dark = document.body !== null && document.body.hasAttribute('data-ds-dark-theme') } catch (e) { /* default light */ }
      var fallback = dark ? '#e6edf3' : '#0f1115'
      try {
        if (typeof document !== 'undefined' && typeof getComputedStyle === 'function' && document.body) {
          var probe = document.createElement('div')
          probe.style.color = 'var(--dsw-alias-label-primary)'
          document.body.appendChild(probe)
          var resolved = getComputedStyle(probe).color
          document.body.removeChild(probe)
          if (resolved && resolved !== 'rgba(0, 0, 0, 0)' && resolved !== 'transparent') return resolved
        }
      } catch (e) { /* use fallback */ }
      return fallback
    }

    exports.inject = ['slots', 'remote', 'uiWorkspace', 'sidebarRightTabs', 'sessions']

    exports.apply = function apply(ctx) {
      // Inject a small set of theme-aware control styles (hover / focus /
      // disabled). Backgrounds are deliberately left to the theme so buttons
      // adapt to dark and light instead of forcing a hard-coded box.
      if (typeof document !== 'undefined' && document.head && !document.getElementById('dsh-rw-controls')) {
        var styleEl = document.createElement('style')
        styleEl.id = 'dsh-rw-controls'
        styleEl.textContent = [
          '.dsh-rw-btn button:disabled{opacity:.5;cursor:not-allowed}',
          '.dsh-rw-btn button:focus-visible{outline:2px solid #6e56cf;outline-offset:2px}',
          '.dsh-rw-btn input:focus,.dsh-rw-btn select:focus{box-shadow:0 0 0 1px #6e56cf}',
          // The host chooser sits inside the always-dark modal (modalBg #1f1f21,
          // text #e8e8e8), but a native <select> renders its option popup on the
          // OS theme. Without dark color-scheme the light inherited text lands on
          // a light popup and the host list is unreadable. Force the popup dark,
          // and give the options an explicit light-on-dark fallback.
          '.dsh-rw-btn select{color-scheme:dark}',
          '.dsh-rw-btn select option{color:#e8e8e8;background:#1f1f21}',
          '.dsh-rw-btn select option:checked{background:#6e56cf;color:#fff}',
        ].join('\n')
        document.head.appendChild(styleEl)
      }

      // Inject xterm's stylesheet (inlined as text by the esbuild build).
      if (typeof document !== 'undefined' && document.head && xtermCss && !document.getElementById('dsh-rw-xterm')) {
        var xtermStyle = document.createElement('style')
        xtermStyle.id = 'dsh-rw-xterm'
        xtermStyle.textContent = xtermCss
          + '\n.dsh-rw-shell .xterm{height:100%}'
          + '\n.dsh-rw-shell .xterm-viewport{background-color:transparent!important}'
          + '\n.dsh-rw-shell .xterm-screen{background-color:transparent!important}'
        document.head.appendChild(xtermStyle)
      }

      var mount = ctx.remote.$mount({ package: PACKAGE, descriptors: INVOCATIONS })
      var getRemote = function () { return ctx.get('remote.' + NAMESPACE) }
      var getCwd = function () {
        try {
          var sessions = ctx.sessions
          if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return undefined
          var snap = sessions.list.getSnapshot()
          var id = snap && snap.current
          var row = id && snap.byId ? snap.byId[id] : undefined
          return row ? row.cwd : undefined
        } catch (e) { return undefined }
      }
      var getSessionId = function () {
        try {
          var sessions = ctx.sessions
          if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return undefined
          var snap = sessions.list.getSnapshot()
          return snap && snap.current ? String(snap.current) : undefined
        } catch (e) { return undefined }
      }

      // Settings section: machines + open remote workspaces (grouped by host).
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'dsh-remote-workspaces', order: 100, label: '远程工作区' },
          function () {
            return React.createElement(SshWorkspaceSection, {
              mount: mount,
              getRemote: getRemote,
            })
          },
        )
      })

      // Shell tab type + body (real xterm terminal; S0 = local shell only).
      var SHELL_KIND = 'shell'
      var SHELL_ID = 'dsh-remote-workspaces/shell'
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: SHELL_ID,
          kind: SHELL_KIND,
          priority: 'extension',
          title: function () { return 'Shell' },
          guide: [{
            order: 20,
            title: function () { return 'Shell' },
            description: function () { return '打开当前工作区的交互终端' },
            icon: ShellIcon,
          }],
        })
      })
      ctx.slots.inject('sidebar.right.pane.tab', function () {
        return ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: SHELL_ID, inject: function () { return { getRemote: getRemote, getCwd: getCwd, getSessionId: getSessionId } } },
          ShellBody,
        )
      })

      // Composed workspace-add picker (shadows the native chooser at a lower priority).
      var flowInjected = function () {
        return {
          getRemote: getRemote,
          pickLocal: function () { return ctx.uiWorkspace.pickDirectory() },
        }
      }
      ctx.slots.inject('conversation.hero.workspace.directoryFlow', function () {
        return ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
          yield ctx.slots.register(
            { name: 'conversation.hero.workspace.directoryFlow', inject: flowInjected, priority: -1 },
            RemoteDirectoryFlow,
          )
          yield ctx.slots.register(
            { name: 'sidebar.workspaces.directoryFlow', inject: flowInjected, priority: -1 },
            RemoteDirectoryFlow,
          )
        })
      })
    }
