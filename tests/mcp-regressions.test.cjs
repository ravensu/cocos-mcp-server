const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ComponentTools } = require('../dist/tools/component-tools');
const { NodeTools } = require('../dist/tools/node-tools');
const { PrefabTools } = require('../dist/tools/prefab-tools');
const { DebugTools } = require('../dist/tools/debug-tools');
const { SceneAdvancedTools } = require('../dist/tools/scene-advanced-tools');

function editor(request) { global.Editor = { Message: { request } }; }
test('remove component uses instance UUID and verifies exact removal', async () => {
  let removed = false;
  editor(async (channel, message, args) => {
    if (message === 'query-node') return { __comps__: removed ? [] : [{ type: 'cc.Layout', value: { uuid: { value: 'layout-instance' } } }] };
    assert.equal(message, 'remove-component'); assert.deepEqual(args, { uuid: 'layout-instance' }); removed = true;
  });
  assert.equal((await new ComponentTools().execute('remove_component', { nodeUuid: 'node', componentType: 'cc.Layout' })).success, true);
});
test('remove component cannot report success when readback fails', async () => {
  let removed = false;
  editor(async (_, message) => { if (message === 'remove-component') { removed = true; return; } return removed ? null : { __comps__: [{ type: 'cc.Layout', uuid: 'instance' }] }; });
  assert.equal((await new ComponentTools().execute('remove_component', { nodeUuid: 'node', componentType: 'cc.Layout' })).success, false);
});
test('partial position retains all untouched axes, including nonzero UI z', async () => {
  const tool = new NodeTools(); let position = { x: 17, y: 29, z: 6 };
  tool.getNodeInfo = async () => ({ success: true, data: { position: { ...position }, components: [{ type: 'cc.Label' }] } });
  editor(async (_, message, args) => { assert.equal(message, 'set-property'); position = args.dump.value; });
  const result = await tool.execute('set_node_transform', { uuid: 'node', position: { y: 0 } });
  assert.equal(result.success, true); assert.deepEqual(position, { x: 17, y: 0, z: 6 });
});
test('incomplete or nonfinite position is rejected before mutation', async () => {
  const tool = new NodeTools(); tool.getNodeInfo = async () => ({ success: true, data: { position: { y: 7, z: 0 }, components: [] } });
  let writes = 0; editor(async () => { writes++; });
  assert.equal((await tool.execute('set_node_transform', { uuid: 'node', position: { y: 2 } })).success, false);
  assert.equal(writes, 0);
});
test('same-parent reorder records undo and checks the actual sibling index', async () => {
  const calls = [];
  editor(async (_, message, args) => { calls.push(message); if (message === 'execute-scene-script') { assert.equal(args.method, 'reorderNode'); return { success: true, data: { siblingIndex: 1 } }; } return 'undo'; });
  assert.equal((await new NodeTools().execute('move_node', { nodeUuid: 'child', newParentUuid: 'parent', siblingIndex: 1 })).success, true);
  assert.deepEqual(calls, ['set-parent', 'begin-recording', 'execute-scene-script', 'end-recording']);
});
test('reorder mismatch is a failure and closes the undo recording', async () => {
  let ended = false;
  editor(async (_, message) => { if (message === 'end-recording') ended = true; if (message === 'execute-scene-script') return { success: true, data: { siblingIndex: 3 } }; });
  assert.equal((await new NodeTools().execute('move_node', { nodeUuid: 'child', newParentUuid: 'parent', siblingIndex: 1 })).success, false);
  assert.equal(ended, true);
});
test('prefab instantiation requests a linked prefab and verifies engine ownership', async () => {
  editor(async (_, message, args) => {
    if (message === 'query-asset-info') return { uuid: 'asset', name: 'Source' };
    if (message === 'create-node') { assert.equal(args.type, 'cc.Prefab'); assert.equal(args.unlinkPrefab, false); assert.deepEqual(args.position, { x: 1, y: 2, z: 3 }); return 'created'; }
    assert.equal(args.method, 'verifyPrefabLink'); assert.deepEqual(args.args, ['created', 'asset']); return { success: true };
  });
  assert.equal((await new PrefabTools().execute('instantiate_prefab', { prefabPath: 'db://assets/Test.prefab', position: { x: 1, y: 2, z: 3 } })).success, true);
});
test('missing prefab link fails without a second creation attempt', async () => {
  let creates = 0;
  editor(async (_, message) => { if (message === 'query-asset-info') return { uuid: 'asset' }; if (message === 'create-node') { creates++; return 'created'; } return { success: false, error: 'wrong source' }; });
  const result = await new PrefabTools().execute('instantiate_prefab', { prefabPath: 'test' });
  assert.equal(result.success, false); assert.match(result.error, /created.*wrong source/); assert.equal(creates, 1);
});
test('scene method undefined/failure cannot be reported as success', async () => {
  const tool = new SceneAdvancedTools();
  for (const response of [undefined, { success: false, error: 'not loaded' }]) { editor(async () => response); assert.equal((await tool.execute('execute_scene_script', { name: 'test', method: 'probe' })).success, false); }
  editor(async () => ({ success: true, data: 0 })); assert.equal((await tool.execute('execute_scene_script', { name: 'test', method: 'probe' })).success, true);
});
test('debug execution uses registered extension method and propagates failures', async () => {
  const tool = new DebugTools();
  editor(async (_, message, args) => { assert.equal(args.name, 'cocos-mcp-server'); assert.equal(args.method, 'executeScript'); return { success: true, data: 42 }; });
  assert.equal((await tool.execute('execute_script', { script: '21 * 2' })).data.result, 42);
  editor(async () => ({ success: false, error: 'script failed' })); assert.equal((await tool.execute('execute_script', { script: 'bad' })).success, false);
});
test('debug tree unwraps Creator dumps and child UUIDs', async () => {
  editor(async (_, message, uuid) => {
    assert.equal(message, 'query-node');
    if (uuid === 'root') return { uuid: { value: 'root' }, name: { value: 'Root' }, active: { value: true }, __comps__: [{ type: 'cc.Layout' }], children: [{ value: { uuid: 'leaf' }, type: 'cc.Node' }] };
    assert.equal(uuid, 'leaf'); return { uuid: { value: 'leaf' }, name: { value: 'Leaf' }, children: [] };
  });
  const result = await new DebugTools().execute('get_node_tree', { rootUuid: 'root', maxDepth: 2 });
  assert.equal(result.success, true); assert.equal(result.data.children[0].uuid, 'leaf'); assert.deepEqual(result.data.components, ['cc.Layout']);
});
test('debug tree cannot hide a child read failure in a successful response', async () => {
  editor(async () => null);
  assert.equal((await new DebugTools().execute('get_node_tree', { rootUuid: 'missing' })).success, false);
});
test('position success requires matching readback', async () => {
  const tool = new NodeTools(); tool.getNodeInfo = async () => ({ success: true, data: { position: { x: 1, y: 2, z: 3 }, components: [] } });
  editor(async () => undefined);
  assert.equal((await tool.execute('set_node_transform', { uuid: 'node', position: { y: 8 } })).success, false);
});
