import { describe, expect, it } from 'vitest';
import { createProject } from '../src/domain/model';
import { compareVersions, orderedVersionNodes } from '../src/domain/version-order';
import { layoutDag } from '../src/domain/layout';

function fixture(versions: string[]) {
  const graph = createProject('排序测试', '001');
  graph.nodes = versions.map((version, index) => ({
    id: `n${index}`, projectId: graph.project.id, version, description: '', taskId: null, releasedAt: null,
  }));
  return graph;
}

describe('版本排序', () => {
  it('小版本后的 SP-1 保留为完整标记，不误判第四段数字版本', () => {
    const ascending = [
      'V1.0-29 20261231',
      'V1.0-29-SP-1 20260701',
      'V1.0-29-SP-2 20200101',
      'V1.0-29-SP-10 20200101',
      'V1.0-30 20200101',
      'V1.0-31-R50 20260827',
      'V1.0-31-R52 20260826',
    ];
    const graph = fixture([...ascending].reverse());
    for (const order of ['oldest', 'newest'] as const) {
      const expected = order === 'oldest' ? ascending : [...ascending].reverse();
      expect(orderedVersionNodes(graph, order).map(node => node.version)).toEqual(expected);
      const layout = layoutDag(graph, order);
      expect(expected.map(version => layout.positions.get(graph.nodes.find(node => node.version === version)!.id)!.y))
        .toEqual(expected.map((_, index) => index * 100));
    }
    expect(compareVersions('V1.0-29-SP-1', 'V1.0-30')).toBeLessThan(0);
    expect(compareVersions('V1.0-29-SP-1 20260701', 'V1.0-29-SP-1 20260702')).toBeLessThan(0);
  });

  it('特殊标记按位置参与排序，不把含标记的版本整体归到末尾', () => {
    const ascending = [
      'V1.0-27 20261231',
      'V1.0-27-SP1 20250709',
      'V1.0-27-SP2 20200101',
      'V1.0-27-SP10 20200101',
      'V1.0-29 20260325',
      'V1.0-29 20260325-test',
      'V1.0-29 20260409 test',
      'V1.0-29 20260414 test',
      'V1.0-30 20200101',
    ];
    const graph = fixture([...ascending].reverse());
    expect(orderedVersionNodes(graph, 'oldest').map(node => node.version)).toEqual(ascending);
    expect(orderedVersionNodes(graph, 'newest').map(node => node.version)).toEqual([...ascending].reverse());
    for (const order of ['oldest', 'newest'] as const) {
      const layout = layoutDag(graph, order);
      const expected = order === 'oldest' ? ascending : [...ascending].reverse();
      expect(expected.map(version => layout.positions.get(graph.nodes.find(node => node.version === version)!.id)!.y))
        .toEqual(expected.map((_, index) => index * 100));
    }
  });

  it('标记所在段优先于后续数字/日期，日期后标记晚于日期比较', () => {
    const pairs = [
      ['V1-SP1.99-99 20261231', 'V1-SP2.0-0 20200101'],
      ['V1.0-test-99 20261231', 'V1.0-test2-0 20200101'],
      ['V1.0-27-SP1 20261231', 'V1.0-27-SP2 20200101'],
      ['V1.0-27 20261231', 'V1.0-27-SP1 20200101'],
      ['V1.0-27 20200101 test10', 'V1.0-27 20200102 test1'],
      ['V1.0-27 20200101 test2', 'V1.0-27 20200101 test10'],
      ['V1.0-27 20200101', 'V1.0-27 20200101 test'],
      ['V1.0-27-SP1', 'V1.0-27-SP1 20200101'],
    ];
    for (const [a, b] of pairs) {
      expect(compareVersions(a!, b!)).toBeLessThan(0);
      expect(compareVersions(b!, a!)).toBeGreaterThan(0);
    }
  });

  it('混合标记与自定义版本的比较保持反对称和传递性', () => {
    const values = ['V1.0-27', 'V1.0-27-SP1 20250709', 'V1.0-29 20260325-test',
      'V1.0-29 20260409 test', 'V1-test.0-1', 'V1.0-2 20260101 SP10', 'custom2', 'V1.0.2.3',
      'V1.0-29-SP-1 20260701', 'V1.0-31-R52 20260826'];
    for (const a of values) for (const b of values) {
      expect(Math.sign(compareVersions(a, b)) + Math.sign(compareVersions(b, a))).toBe(0);
      for (const c of values) {
        if (compareVersions(a, b) <= 0 && compareVersions(b, c) <= 0) {
          expect(compareVersions(a, c)).toBeLessThanOrEqual(0);
        }
      }
    }
  });

  it('按大、中、小、日期逐级比较数字，不按文本或创建顺序', () => {
    const versions = [
      'V2.0-0 20200101', 'V1.10-0 20200101', 'V1.2-10 20200101',
      'V1.2-2 20261030', 'V1.2-2 20260901', 'V1.2-2', 'V1.0-3 20261016',
      'V1.0-2 20260929', 'V1.0-1 20260905', 'V1.0-1 20260901',
    ];
    const graph = fixture(versions);
    const before = structuredClone(graph);
    const expected = [...versions].reverse();
    expect(orderedVersionNodes(graph, 'oldest').map(node => node.version)).toEqual(expected);
    expect(orderedVersionNodes(graph, 'newest').map(node => node.version)).toEqual(versions);
    expect(graph).toEqual(before);
  });

  it('相等数字、缺省段、大小写及自定义文本采用确定性兜底', () => {
    const values = ['custom10', 'custom2', 'v1.0-2', 'V01.0-2', 'V1', 'V1.0-0'];
    const graph = fixture(values);
    const sorted = orderedVersionNodes(graph, 'oldest').map(node => node.version);
    expect(sorted.indexOf('custom2')).toBeLessThan(sorted.indexOf('custom10'));
    expect(sorted.indexOf('V1')).toBeLessThan(sorted.indexOf('v1.0-2'));
    expect(compareVersions('V999999999999999999999', 'V1000000000000000000000')).toBeLessThan(0);
    expect(compareVersions('', '')).toBe(0);
    for (const a of values) for (const b of values) {
      expect(Math.sign(compareVersions(a, b)) + Math.sign(compareVersions(b, a))).toBe(0);
    }
    graph.nodes.reverse();
    expect(orderedVersionNodes(graph, 'oldest').map(node => node.version)).toEqual(sorted);
  });

  it('无关系的根和同父兄弟按方向排布；父子/合并深度不倒置', () => {
    const graph = fixture(['V1.0-10', 'V1.0-2', 'V2.0-0', 'V0.0-1']);
    for (const order of ['oldest', 'newest'] as const) {
      const sorted = orderedVersionNodes(graph, order);
      const layout = layoutDag(graph, order);
      expect([...sorted].map(node => layout.positions.get(node.id)!.y)).toEqual([0, 100, 200, 300]);
    }
    graph.edges = [
      { id: 'a', projectId: graph.project.id, parentId: 'n2', childId: 'n0' },
      { id: 'b', projectId: graph.project.id, parentId: 'n2', childId: 'n1' },
      { id: 'c', projectId: graph.project.id, parentId: 'n0', childId: 'n3' },
      { id: 'd', projectId: graph.project.id, parentId: 'n1', childId: 'n3' },
    ];
    for (const order of ['oldest', 'newest'] as const) {
      const ids = orderedVersionNodes(graph, order).map(node => node.id);
      const layout = layoutDag(graph, order);
      for (const edge of graph.edges) {
        expect(ids.indexOf(edge.parentId)).toBeLessThan(ids.indexOf(edge.childId));
        expect(layout.positions.get(edge.parentId)!.x).toBeLessThan(layout.positions.get(edge.childId)!.x);
      }
      const small = layout.positions.get('n1')!.y;
      const large = layout.positions.get('n0')!.y;
      expect(order === 'oldest' ? small < large : small > large).toBe(true);
    }
  });

  it('空图返回空列表，非法环图明确拒绝', () => {
    expect(orderedVersionNodes(fixture([]), 'oldest')).toEqual([]);
    const graph = fixture(['V1', 'V2']);
    graph.edges = [
      { id: 'a', projectId: graph.project.id, parentId: 'n0', childId: 'n1' },
      { id: 'b', projectId: graph.project.id, parentId: 'n1', childId: 'n0' },
    ];
    expect(() => orderedVersionNodes(graph, 'newest')).toThrow('成环');
  });
});
