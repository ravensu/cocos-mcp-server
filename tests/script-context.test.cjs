const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ComponentTools } = require('../dist/tools/component-tools');

function sceneMethods() {
  const local = { UITransform: class UITransform {} };
  const context = { exports: {}, module: { paths: [] }, Editor: { App: { path: '.' } },
    cc: { UITransform: class StaleUITransform {} },
    require: name => name === 'cc' ? local : name === 'path' ? require('node:path') : {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/scene'), 'utf8'), context);
  return context.exports.methods;
}

test('script cc constructors come from active engine, not stale global', async () => {
  const result = await sceneMethods().executeScript('cc.UITransform === require("cc").UITransform');
  assert.equal(result.success, true);
  assert.equal(result.data, true);
});

test('expression, async IIFE, top-level return and runtime failure preserve eval semantics', async () => {
  const methods = sceneMethods();
  assert.equal((await methods.executeScript('21 * 2')).data, 42);
  assert.equal((await methods.executeScript('(async () => { return 7; })()')).data, 7);
  const bad = await methods.executeScript('return 3');
  assert.equal(bad.success, false);
  assert.match(bad.error, /Use an IIFE/);
  assert.equal((await methods.executeScript('throw new Error("once")')).error, 'once');
});

test('custom class name resolves to cid for writing and verification; cid skips resolution', async () => {
  for (const name of ['TextMeshPro', 'compressed-cid']) {
    const tool = new ComponentTools();
    let resolutions = 0, writes = 0;
    tool.getComponents = async () => ({ success: true, data: { components: [{ type: 'compressed-cid' }] } });
    tool.analyzeProperty = () => ({ exists: true, originalValue: 20 });
    tool.verifyPropertyChange = async (_, type, prop, before, after) => {
      assert.equal(type, 'compressed-cid'); assert.equal(after, 23);
      return { success: true };
    };
    global.Editor = { Message: { request: async (_, message, args) => {
      if (message === 'execute-scene-script') {
        resolutions++;
        const cc = { director: { getScene: () => ({ uuid: 'root', children: [{ uuid: 'parent', children: [{ uuid: 'node', components: [{}] }] }] }) },
          js: { getClassName: () => 'TextMeshPro', getClassId: () => 'compressed-cid' } };
        return { success: true, data: vm.runInNewContext(args.args[0], { require: () => cc }) };
      }
      if (message === 'query-node') return { __comps__: [{ type: 'cc.UITransform' }, { type: 'compressed-cid' }] };
      assert.equal(message, 'set-property'); assert.equal(args.path, '__comps__.1.fontSize'); writes++;
    } } };
    const result = await tool.execute('set_component_property', { nodeUuid: 'node', componentType: name, property: 'fontSize', propertyType: 'number', value: 23 });
    assert.equal(result.success, true); assert.equal(writes, 1);
    assert.equal(resolutions, name === 'TextMeshPro' ? 1 : 0);
  }
});

test('failed class resolution performs no property writes', async () => {
  const tool = new ComponentTools();
  tool.getComponents = async () => ({ success: true, data: { components: [] } });
  global.Editor = { Message: { request: async (_, message) => {
    assert.equal(message, 'execute-scene-script'); return { success: false, error: 'ambiguous class' };
  } } };
  const result = await tool.execute('set_component_property', { nodeUuid: 'node', componentType: 'Missing', property: 'fontSize', value: 23 });
  assert.equal(result.success, false);
});
