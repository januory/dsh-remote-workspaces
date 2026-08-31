/**
 * Browser half of the SSH remote workspace plugin:
 *
 * 1. A "远程工作区" settings section — a multi-machine SSH registry (add /
 *    edit / delete / test) with `~/.ssh/config` as a one-click form-fill
 *    convenience. NO remote browsing here.
 *
 * 2. A composed directory-flow picker registered into the harness's two
 *    workspace-add holes (`conversation.hero.workspace.directoryFlow` and
 *    `sidebar.workspaces.directoryFlow`) at a lower priority so it shadows the
 *    native chooser and offers BOTH "本地文件夹" (delegates to the host
 *    chooser) and "远程目录" (pick a machine → browse the remote → SFTP-mirror
 *    → hand the local mirror path back through `onPicked`).
 *
 * Served verbatim as a classic script, so it self-registers through
 * `window.__ModuleLoader__` in factory form (no ESM import/export); `react` is
 * a platform seed word resolved via `require("react")`.
 */

// ---------------------------------------------------------------------------
// Remote contract (must match src/index.js). Parameters carry strict codecs
// with a pass-through `parse` (the client `$mount` face rejects `src-json`).
// ---------------------------------------------------------------------------
var PACKAGE = 'remote-workspaces'
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
  invocation('mirrorRemote', [jsonParameter('machine'), jsonParameter('path')]),
  invocation('listMirrors'),
  invocation('syncMirror', [jsonParameter('localDir')]),
  invocation('listSyncLog', [jsonParameter('query')]),
  invocation('clearSyncLog'),
  invocation('removeMirror', [jsonParameter('localDir')]),
  invocation('cleanOrphans'),
]

function unwrapRemote(res) {
  if (res === undefined || res === null) return { ok: false, error: '无响应' }
  if (res.ok === false) {
    var e = res.error
    return { ok: false, error: e && e.message ? e.message : '调用失败' }
  }
  return res.value || { ok: false, error: '空结果' }
}

window.__ModuleLoader__.load({
  id: PACKAGE,
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var sectionStyle = { padding: 16, fontSize: 14, lineHeight: 1.6, maxWidth: 820 }
    var labelStyle = { color: 'var(--dsw-alias-label-secondary, #888)', margin: 0, fontSize: 12.5 }
    var monoStyle = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12.5 }
    var btnStyle = { padding: '5px 12px', cursor: 'pointer' }
    var inputStyle = { padding: '5px 8px', fontSize: 13, width: '100%', boxSizing: 'border-box' }
    var dangerColor = 'var(--dsw-alias-danger, #c00)'
    var successColor = 'var(--dsw-alias-success, #0a0)'
    var borderColor = 'var(--dsw-alias-border, #333)'
    var chipStyle = { display: 'inline-block', padding: '1px 8px', borderRadius: 10, background: 'rgba(127,127,127,0.18)', fontSize: 11.5, lineHeight: '18px' }

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
      var mirrorsState = React.useState([])
      var mirrors = mirrorsState[0]
      var setMirrors = mirrorsState[1]
      var mirrorsLoadedState = React.useState(false)
      var mirrorsLoaded = mirrorsLoadedState[0]
      var setMirrorsLoaded = mirrorsLoadedState[1]
      var syncingState = React.useState({})
      var syncing = syncingState[0]
      var setSyncing = syncingState[1]
      var syncResultsState = React.useState({})
      var syncResults = syncResultsState[0]
      var setSyncResults = syncResultsState[1]
      var logState = React.useState([])
      var log = logState[0]
      var setLog = logState[1]
      var logLoadingState = React.useState(false)
      var logLoading = logLoadingState[0]
      var setLogLoading = logLoadingState[1]
      var showLogState = React.useState(false)
      var showLog = showLogState[0]
      var setShowLog = showLogState[1]
      var expandedState = React.useState({})
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]
      var expandedHostsState = React.useState({})
      var expandedHosts = expandedHostsState[0]
      var setExpandedHosts = expandedHostsState[1]
      var deleteTargetState = React.useState(null)
      var deleteTarget = deleteTargetState[0]
      var setDeleteTarget = deleteTargetState[1]
      var deletingState = React.useState(false)
      var deleting = deletingState[0]
      var setDeleting = deletingState[1]

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
            refreshMirrors(ns)
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
        var itsMirrors = mirrorsForMachine(machine)
        Promise.all(itsMirrors.map(function (m) {
          return remote.removeMirror(m.localDir).catch(function () {})
        })).then(function () {
          return remote.deleteMachine(machine.id)
        }).then(
          function () {
            setDeleting(false)
            setDeleteTarget(null)
            refreshMachines()
            refreshMirrors()
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

      function refreshMirrors(ns) {
        var n = ns || remote
        if (!n) return
        n.listMirrors().then(
          function (res) {
            var b = unwrapRemote(res)
            if (b.ok) setMirrors(b.mirrors || [])
            setMirrorsLoaded(true)
          },
          function () { setMirrorsLoaded(true) },
        )
      }

      function doSync(localDir) {
        setSyncing(function (prev) { var n = Object.assign({}, prev); n[localDir] = true; return n })
        remote.syncMirror(localDir).then(
          function (res) {
            var b = unwrapRemote(res)
            setSyncing(function (prev) { var n = Object.assign({}, prev); n[localDir] = false; return n })
            setSyncResults(function (prev) { var n = Object.assign({}, prev); n[localDir] = b; return n })
            refreshMirrors()
            loadLog()
          },
          function (err) {
            setSyncing(function (prev) { var n = Object.assign({}, prev); n[localDir] = false; return n })
            setSyncResults(function (prev) {
              var n = Object.assign({}, prev)
              n[localDir] = { ok: false, error: err && err.message ? err.message : String(err) }
              return n
            })
          },
        )
      }

      function doSyncAll() {
        if (!remote || syncing.__all) return
        setSyncing(function (prev) { var n = Object.assign({}, prev); n.__all = true; return n })
        Promise.all(mirrors.map(function (m) {
          return remote.syncMirror(m.localDir).then(unwrapRemote)
        })).then(
          function () {
            setSyncing(function (prev) { var n = Object.assign({}, prev); n.__all = false; return n })
            refreshMirrors()
            loadLog()
          },
          function () {
            setSyncing(function (prev) { var n = Object.assign({}, prev); n.__all = false; return n })
            refreshMirrors()
          },
        )
      }

      function doCleanOrphans() {
        if (!remote) return
        setSyncing(function (prev) { var n = Object.assign({}, prev); n.__clean = true; return n })
        remote.cleanOrphans().then(
          function (res) {
            var b = unwrapRemote(res)
            setSyncing(function (prev) { var n = Object.assign({}, prev); n.__clean = false; return n })
            if (!b.ok) setError(b.error || '清理孤儿文件夹失败')
            refreshMirrors()
            loadLog()
          },
          function (err) {
            setSyncing(function (prev) { var n = Object.assign({}, prev); n.__clean = false; return n })
            setError(err && err.message ? err.message : String(err))
          },
        )
      }

      function doRemove(localDir) {
        if (!remote) return
        setSyncing(function (prev) { var n = Object.assign({}, prev); n[localDir] = true; return n })
        remote.removeMirror(localDir).then(
          function () {
            setSyncing(function (prev) { var n = Object.assign({}, prev); n[localDir] = false; return n })
            refreshMirrors()
            loadLog()
          },
          function (err) {
            setSyncing(function (prev) { var n = Object.assign({}, prev); n[localDir] = false; return n })
            setError(err && err.message ? err.message : String(err))
          },
        )
      }

      function loadLog() {
        if (!remote) return
        setLogLoading(true)
        remote.listSyncLog({ limit: 50 }).then(
          function (res) {
            var b = unwrapRemote(res)
            setLogLoading(false)
            if (b.ok) setLog(b.entries || [])
          },
          function () { setLogLoading(false) },
        )
      }

      function doClearLog() {
        if (!remote) return
        remote.clearSyncLog().then(function () { setLog([]) })
      }

      function toggleShowLog() {
        var next = !showLog
        setShowLog(next)
        if (next) loadLog()
      }

      function toggleExpanded(key) {
        setExpanded(function (prev) {
          var n = Object.assign({}, prev)
          n[key] = !prev[key]
          return n
        })
      }

      function toggleHost(id) {
        setExpandedHosts(function (prev) {
          var n = Object.assign({}, prev)
          n[id] = prev[id] === false // default open → first click collapses
          return n
        })
      }

      function mirrorsForMachine(machine) {
        return mirrors.filter(function (m) {
          return !m.orphan
            && m.host === machine.host
            && String(m.user || '') === String(machine.user || '')
            && (Number(m.port) || 22) === (Number(machine.port) || 22)
        })
      }

      return React.createElement(
        'div',
        { style: sectionStyle },
        React.createElement('div', { style: { fontWeight: 600, fontSize: 16, marginBottom: 8 } }, '远程工作区'),
        React.createElement('p', { style: { margin: '0 0 12px' } },
          '管理 SSH 主机与已打开的远程工作区。添加远程工作区请在侧边栏「添加工作区」里选「远程目录」；本地改动会自动同步回远端。'),
        mountError !== null
          ? React.createElement('p', { style: { color: dangerColor, margin: '0 0 12px' } }, 'Remote 命名空间挂载失败：' + mountError)
          : null,
        error !== null
          ? React.createElement('p', { style: { color: dangerColor, margin: '0 0 12px' } }, error)
          : null,
        React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 12 } },
          React.createElement('button', { type: 'button', onClick: openNew, disabled: !remote, style: btnStyle }, '添加主机'),
          React.createElement('button', { type: 'button', onClick: toggleAliases, disabled: !remote, style: btnStyle }, '从 ~/.ssh/config 导入'),
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
                  React.createElement('span', { style: { flex: 1 } }),
                  React.createElement('button', { type: 'button', onClick: doSyncAll, disabled: !remote || mirrors.length === 0 || syncing.__all, style: btnStyle }, syncing.__all ? '同步中…' : '全部同步'),
                ),
                machines.map(function (machine) {
                  var open = expandedHosts[machine.id] !== false
                  return MachineRow(
                    machine,
                    results[machine.id],
                    mirrorsForMachine(machine),
                    open,
                    function () { toggleHost(machine.id) },
                    function () { doTest(machine) },
                    function () { openEdit(machine) },
                    function () { doDelete(machine) },
                    function (localDir) { doSync(localDir) },
                    syncing,
                    syncResults,
                  )
                }),
              ),
        (function () {
          var orphans = mirrors.filter(function (m) { return m.orphan })
          if (orphans.length === 0) return null
          return React.createElement('div', { style: { marginTop: 12, borderTop: '1px solid ' + borderColor, paddingTop: 8 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
              React.createElement('div', { style: { fontWeight: 600, color: dangerColor } }, '已删除工作区（' + orphans.length + '）'),
              React.createElement('span', { style: { flex: 1 } }),
              React.createElement('button', { type: 'button', onClick: doCleanOrphans, disabled: !remote || syncing.__clean, style: btnStyle }, syncing.__clean ? '清理中…' : '全部清理'),
            ),
            orphans.map(function (m) {
              return MirrorRow(m, !!syncing[m.localDir], null, function () { doRemove(m.localDir) })
            }),
          )
        })(),
        React.createElement('div', { style: { marginTop: 20, borderTop: '1px solid ' + borderColor, paddingTop: 12 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
            React.createElement('button', { type: 'button', onClick: toggleShowLog, style: btnStyle }, showLog ? '收起同步日志' : '同步日志'),
            showLog ? React.createElement('button', { type: 'button', onClick: loadLog, disabled: logLoading, style: btnStyle }, '刷新日志') : null,
            showLog ? React.createElement('button', { type: 'button', onClick: doClearLog, style: btnStyle }, '清空日志') : null,
          ),
          showLog
            ? logLoading
              ? React.createElement('div', { style: labelStyle }, '加载中…')
              : log.length === 0
                ? React.createElement('div', { style: labelStyle }, '暂无同步记录。')
                : log.map(function (e, i) {
                    return SyncLogRow(e, !!expanded[i], function () { toggleExpanded(i) }, i)
                  })
            : null,
        ),
        deleteTarget !== null
          ? React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 } },
              React.createElement('div', { style: { background: 'var(--dsw-alias-bg, #1c1c1c)', border: '1px solid ' + borderColor, borderRadius: 8, padding: 16, width: 440, maxWidth: '90vw', color: 'var(--dsw-alias-text, #ddd)' } },
                React.createElement('div', { style: { fontWeight: 600, fontSize: 15, marginBottom: 10 } }, '删除主机'),
                React.createElement('p', { style: { margin: '0 0 12px', lineHeight: 1.6 } },
                  '确定删除主机「' + (deleteTarget.alias || deleteTarget.host) + '」吗？'
                  + (mirrorsForMachine(deleteTarget).length > 0
                    ? ' 这会同时删除它的 ' + mirrorsForMachine(deleteTarget).length + ' 个远程工作区本地镜像（远端数据不受影响）。'
                    : '')),
                React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                  React.createElement('button', { type: 'button', onClick: closeDelete, disabled: deleting, style: btnStyle }, '取消'),
                  React.createElement('button', { type: 'button', onClick: confirmDelete, disabled: deleting, style: Object.assign({}, btnStyle, { background: dangerColor, color: '#fff', borderColor: dangerColor }) }, deleting ? '删除中…' : '删除'),
                ),
              ),
            )
          : null,
      )
    }

    function MachineRow(machine, result, mirrors, open, onToggle, onTest, onEdit, onDelete, onSync, syncing, syncResults) {
      var summary = [machine.alias || '(未命名)']
      if (machine.host) summary.push(machine.host)
      if (machine.user) summary.push('@' + machine.user)
      if (machine.port) summary.push(':' + machine.port)
      return React.createElement(
        'div',
        { style: { borderTop: '1px solid ' + borderColor, padding: '8px 0' } },
        React.createElement('div', { onClick: onToggle, style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' } },
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary, #888)', width: 16, flexShrink: 0 } }, open ? '▾' : '▸'),
          React.createElement('span', { style: Object.assign({}, monoStyle, { fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }, summary.join(' ')),
          React.createElement('span', { style: { flex: 1 } }),
          React.createElement('button', { type: 'button', onClick: function (e) { e.stopPropagation(); onTest() }, style: btnStyle }, '测试连接'),
          React.createElement('button', { type: 'button', onClick: function (e) { e.stopPropagation(); onEdit() }, style: btnStyle }, '编辑'),
          React.createElement('button', { type: 'button', onClick: function (e) { e.stopPropagation(); onDelete() }, style: btnStyle }, '删除'),
        ),
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
        open
          ? mirrors.length === 0
            ? React.createElement('div', { style: Object.assign({}, labelStyle, { paddingLeft: 24, marginTop: 4 }) }, '还没有打开过此主机的远程工作区')
            : React.createElement('div', { style: { paddingLeft: 24, marginTop: 2 } },
                mirrors.map(function (m) {
                  return MirrorRow(m, !!syncing[m.localDir], syncResults[m.localDir], function () { onSync(m.localDir) })
                }),
              )
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
          React.createElement('input', { type: type || 'text', value: values[name], onChange: set(name), placeholder: placeholder || '', style: inputStyle }),
        )
      }

      return React.createElement(
        'form',
        { onSubmit: submit, style: { border: '1px solid ' + borderColor, borderRadius: 6, padding: 12, marginBottom: 12 } },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, props.form.isNew ? '添加主机' : '编辑主机'),
        field('别名（alias）', 'alias', 'text', '如 dev'),
        field('主机地址（host）', 'host', 'text', '如 192.168.1.10 或 example.com'),
        field('端口（port）', 'port', 'number', '默认 22'),
        field('用户名（user）', 'user', 'text', '默认当前用户'),
        field('私钥路径（identityFile）', 'identityFile', 'text', '如 ~/.ssh/id_rsa，留空用默认密钥'),
        field('密码（password）', 'password', 'password', props.form.isNew ? '可选' : '留空保持不变，输入则替换'),
        field('私钥口令（passphrase）', 'passphrase', 'password', props.form.isNew ? '可选' : '留空保持不变'),
        React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
          React.createElement('button', { type: 'submit', style: btnStyle }, '保存'),
          React.createElement('button', { type: 'button', onClick: props.onCancel, style: btnStyle }, '取消'),
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
        color: entry.dir ? 'var(--dsw-alias-text, #ddd)' : 'var(--dsw-alias-label-secondary, #888)',
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
        entry.dir ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary, #888)', flexShrink: 0 } }, '/') : null,
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
      var mirroringState = React.useState(false)
      var mirroring = mirroringState[0]
      var setMirroring = mirroringState[1]
      var localPickingState = React.useState(false)
      var localPicking = localPickingState[0]
      var setLocalPicking = localPickingState[1]
      var pathInputState = React.useState('')
      var pathInput = pathInputState[0]
      var setPathInput = pathInputState[1]

      // Reset per open edge, then load machines.
      React.useEffect(function () {
        if (!open) return
        setMode('remote')
        setMachines([])
        setMachinesLoaded(false)
        setSelected(null)
        setBrowse(null)
        setMirroring(false)
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
        if (mirroring || !selected || !browse) return
        setMirroring(true)
        getRemote().mirrorRemote(selected, browse.path).then(
          function (res) {
            var b = unwrapRemote(res)
            if (b.ok && b.localDir) onPicked(b.localDir)
            else onError(b.error || '镜像失败')
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
          { style: { background: 'var(--dsw-alias-bg, #1c1c1c)', border: '1px solid ' + borderColor, borderRadius: 8, padding: 16, width: 560, maxWidth: '92vw', maxHeight: '82vh', overflow: 'auto', color: 'var(--dsw-alias-text, #ddd)' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 12 } },
            React.createElement('span', { style: { fontWeight: 600, fontSize: 15 } }, '打开文件夹'),
            React.createElement('span', { style: { flex: 1 } }),
            React.createElement('button', { type: 'button', onClick: onCancel, style: btnStyle }, '取消'),
          ),
          React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 12 } },
            React.createElement('button', { type: 'button', onClick: function () { setMode('local') }, style: Object.assign({}, btnStyle, mode === 'local' ? { border: '2px solid ' + successColor } : {}) }, '本地文件夹'),
            React.createElement('button', { type: 'button', onClick: function () { setMode('remote') }, style: Object.assign({}, btnStyle, mode === 'remote' ? { border: '2px solid ' + successColor } : {}) }, '远程目录'),
          ),
          mode === 'local'
            ? React.createElement('div', {},
                React.createElement('p', { style: { margin: '0 0 12px' } }, '在本机打开系统文件夹选择器，选取一个本地目录作为工作区。'),
                React.createElement('button', { type: 'button', onClick: doLocal, disabled: localPicking || busy, style: btnStyle }, localPicking ? '等待选择…' : '选择本地文件夹'),
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
                      style: Object.assign({}, inputStyle, { marginBottom: 8 }),
                    },
                      React.createElement('option', { value: '' }, '选择主机…'),
                      machines.map(function (m) {
                        return React.createElement('option', { key: m.id, value: m.id }, (m.alias || m.host) + ' (' + m.host + (m.user ? '@' + m.user : '') + ')')
                      }),
                    ),
                selected
                  ? React.createElement('div', { style: { border: '1px solid ' + borderColor, borderRadius: 6, padding: 10 } },
                      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                        React.createElement('input', {
                          type: 'text',
                          value: pathInput,
                          onChange: function (e) { setPathInput(e.target.value) },
                          onKeyDown: function (e) { if (e.key === 'Enter') jumpTo() },
                          placeholder: '输入绝对路径，或 ~ 回到主目录',
                          spellCheck: false,
                          style: Object.assign({}, monoStyle, { flex: 1, minWidth: 0, padding: '5px 8px', fontSize: 13, boxSizing: 'border-box' }),
                        }),
                        React.createElement('button', { type: 'button', onClick: jumpTo, disabled: !browse || browse.loading, style: btnStyle }, '跳转'),
                        React.createElement('button', { type: 'button', onClick: goUp, disabled: !browse || browse.loading || !browse.path || browse.path === '/', style: btnStyle }, '上一级'),
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
                        React.createElement('button', { type: 'button', onClick: doOpenRemote, disabled: mirroring || busy || (browse && browse.loading), style: btnStyle },
                          mirroring ? '镜像中…' : '打开此目录'),
                      ),
                    )
                  : null,
              ),
        ),
      )
    }

    function MirrorRow(m, isSyncing, result, onSync) {
      return React.createElement(
        'div',
        { key: m.localDir, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' } },
        React.createElement('div', { style: { flex: 1, minWidth: 0 } },
          React.createElement('div', { style: monoStyle }, '📁 ' + (m.remotePath || pathBasename(m.localDir))),
          React.createElement('div', { style: labelStyle },
            (m.files || 0) + ' 个文件' + (m.lastSyncedAt ? ' · 上次同步 ' + m.lastSyncedAt.slice(0, 19).replace('T', ' ') : '')),
          result && result.ok === true
            ? React.createElement('div', { style: { color: successColor, margin: 0 } }, '已同步：拉取 ' + result.pulled + '，推送 ' + result.pushed + (result.failed ? '，失败 ' + result.failed : ''))
            : result && result.ok === false
              ? React.createElement('div', { style: { color: dangerColor, margin: 0 } }, result.error || '同步失败')
              : null,
        ),
        React.createElement('button', { type: 'button', onClick: onSync, disabled: isSyncing, style: btnStyle }, isSyncing ? (m.orphan ? '清理中…' : '同步中…') : (m.orphan ? '清理' : '同步')),
      )
    }

    function SyncLogRow(e, isExpanded, onToggle, key) {
      var triggerLabel = { auto: '自动', manual: '手动', mirror: '首次镜像' }[e.trigger] || e.trigger
      var line = (e.ts || '').slice(0, 19).replace('T', ' ')
      var summary = triggerLabel + ' · ' + (e.user ? e.user + '@' : '') + (e.host || '') + ' · ' + (e.remotePath || '')
      var stats = '拉取 ' + (e.pulled || 0) + ' / 推送 ' + (e.pushed || 0) + ' / 跳过 ' + (e.skippedLarge || 0)
        + (e.failed ? ' / 失败 ' + e.failed : '')
      var changes = e.changes || []
      return React.createElement(
        'div',
        { key: key, style: { borderTop: '1px solid ' + borderColor, padding: '6px 0' } },
        React.createElement('div', { onClick: onToggle, style: { display: 'flex', alignItems: 'center', gap: 8, cursor: changes.length ? 'pointer' : 'default' } },
          React.createElement('span', { style: { color: e.ok === false ? dangerColor : 'inherit', fontFamily: 'ui-monospace, monospace', fontSize: 12 } }, line),
          React.createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, summary),
          React.createElement('span', { style: labelStyle }, stats + (changes.length ? ' · ' + changes.length + ' 个文件' : '')),
          changes.length ? React.createElement('span', { style: labelStyle }, isExpanded ? '▾' : '▸') : null,
        ),
        e.ok === false && e.error
          ? React.createElement('div', { style: { color: dangerColor, margin: '2px 0 0' } }, e.error)
          : null,
        isExpanded
          ? React.createElement('div', { style: { marginTop: 4, paddingLeft: 12, fontFamily: 'ui-monospace, monospace', fontSize: 12, maxHeight: 180, overflow: 'auto' } },
              changes.map(function (c, i) {
                var label = { pull: '↓ 拉取', push: '↑ 推送', 'delete-local': '⊘ 本地删除', 'delete-remote': '⊘ 远端删除', 'skip-large': '⏭ 跳过(大)', error: '⚠ 失败' }[c.action] || c.action
                var text = label + '  ' + c.path + (c.error ? ' — ' + c.error : '')
                return React.createElement('div', { key: i, style: { color: c.action === 'error' ? dangerColor : 'var(--dsw-alias-label-secondary, #888)' } }, text)
              }),
            )
          : null,
      )
    }

    exports.inject = ['slots', 'remote', 'uiWorkspace']

    exports.apply = function apply(ctx) {
      var mount = ctx.remote.$mount({ package: PACKAGE, descriptors: INVOCATIONS })
      var getRemote = function () { return ctx.get('remote.' + NAMESPACE) }

      // Settings section: machines + open remote workspaces (grouped by host) + sync log.
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'remote-workspaces', order: 100, label: '远程工作区' },
          function () {
            return React.createElement(SshWorkspaceSection, {
              mount: mount,
              getRemote: getRemote,
            })
          },
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

    return module.exports
  },
})
