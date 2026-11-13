import { describe, expect, it } from 'vitest';
import { createProject } from '../src/domain/model';
import { layoutDag, LAYOUT, nodeSizeForVersion, relationForDropPoint, versionLines } from '../src/domain/layout';
import { placeContextMenu } from '../src/utils/viewport';

function graph(edges: [string, string][]) {
  const g = createProject('工程', '123');
  const p = g.project.id;
  const ids = [...new Set(edges.flat())];
  g.nodes = ids.map(id => ({ id, projectId: p, version: id, description: '', taskId: null, releasedAt: null, testingAt: null }));
  g.edges = edges.map(([parentId, childId], index) => ({ id: `e${index}`, projectId: p, parentId: parentId!, childId: childId! }));
  return g;
}

describe('DAG 分层布局', () => {
  it('长版本号按可读行宽换行且不丢失文本', () => {
    const version = 'V1.0-27 Engineering-Release-2026-11-02 中文版本验证超长标签';
    const lines = versionLines(version);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(version);
    expect(lines.some(line => line.includes('2026-11-02'))).toBe(true);
    expect(nodeSizeForVersion(version).height).toBe(LAYOUT.nodeHeight + (lines.length - 1) * LAYOUT.versionLineHeight);
  });

  it('同一布局行按最高节点动态高度留白', () => {
    const g = graph([['A', 'B'], ['A', 'C']]);
    g.nodes.find(node => node.id === 'B')!.version = 'B'.repeat(65);
    const layout = layoutDag(g);
    const tallNodeHeight = nodeSizeForVersion('B'.repeat(65)).height;
    expect(layout.positions.get('B')!.y).toBe(0);
    expect(layout.positions.get('C')!.y).toBe(tallNodeHeight + LAYOUT.verticalGap);
    expect(layout.height).toBe(tallNodeHeight + LAYOUT.verticalGap + LAYOUT.nodeHeight);
    expect(relationForDropPoint(
      { x: 0, y: 0 },
      { x: 20, y: tallNodeHeight - 1 },
      'newest',
      layout.nodeSizes.get('B')!,
    )).toBe('child');
  });

  it('拖放方向按版本排序模式决定，节点本体仍作为子节点投放', () => {
    const position = { x: 100, y: 100 };
    const points = {
      top: { x: position.x + LAYOUT.nodeWidth / 2, y: position.y - 10 },
      right: { x: position.x + LAYOUT.nodeWidth + 10, y: position.y + LAYOUT.nodeHeight / 2 },
      bottom: { x: position.x + LAYOUT.nodeWidth / 2, y: position.y + LAYOUT.nodeHeight + 10 },
      left: { x: position.x - 10, y: position.y + LAYOUT.nodeHeight / 2 },
      inside: { x: position.x + LAYOUT.nodeWidth / 2, y: position.y + LAYOUT.nodeHeight / 2 },
    };
    expect(Object.fromEntries(
      Object.entries(points).map(([direction, point]) => [
        direction, relationForDropPoint(position, point, 'newest'),
      ]),
    )).toEqual({ top: 'child', right: 'child', bottom: 'parent', left: 'parent', inside: 'child' });
    expect(Object.fromEntries(
      Object.entries(points).map(([direction, point]) => [
        direction, relationForDropPoint(position, point, 'oldest'),
      ]),
    )).toEqual({ top: 'parent', right: 'child', bottom: 'child', left: 'parent', inside: 'child' });
  });

  it('线性链按深度依次排布，坐标落在网格上', () => {
    const layout = layoutDag(graph([['A', 'B'], ['B', 'C'], ['C', 'D']]));
    const pos = layout.positions;
    for (const [id, depth] of [['A', 0], ['B', 1], ['C', 2], ['D', 3]] as const) {
      expect(pos.get(id)!.x).toBe(depth * (LAYOUT.nodeWidth + LAYOUT.horizontalGap));
      expect(pos.get(id)!.y).toBe(0);
    }
    expect(layout.width).toBe(4 * LAYOUT.nodeWidth + 3 * LAYOUT.horizontalGap);
    expect(layout.height).toBe(LAYOUT.nodeHeight);
  });

  it('合并目标深度取最长路径，晚于所有父节点', () => {
    // R -> A -> M; R -> B -> M  => M 在深度 2
    const layout = layoutDag(graph([['R', 'A'], ['A', 'M'], ['R', 'B'], ['B', 'M']]));
    expect(layout.positions.get('M')!.x).toBe(2 * (LAYOUT.nodeWidth + LAYOUT.horizontalGap));
    expect(layout.positions.get('R')!.x).toBe(0);
    expect(layout.positions.get('A')!.x).toBeGreaterThan(layout.positions.get('R')!.x);
  });

  it('同级节点按父顺序纵向排列，不重叠', () => {
    const layout = layoutDag(graph([['R', 'A'], ['R', 'B'], ['R', 'C']]));
    const ys = ['A', 'B', 'C'].map(id => layout.positions.get(id)!.y);
    expect(new Set(ys).size).toBe(3);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it('空图返回空布局', () => {
    const layout = layoutDag(createProject('空', '1'));
    expect(layout.positions.size).toBe(0);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });

  it('环图抛错', () => {
    expect(() => layoutDag(graph([['A', 'B'], ['B', 'A']]))).toThrow('成环');
  });
});

describe('上下文菜单视口定位', () => {
  it('底部锚点优先将菜单翻到节点上方', () => {
    expect(placeContextMenu(
      { x: 900, y: 700 },
      { width: 280, height: 360 },
      { width: 1000, height: 800 },
    )).toEqual({ x: 616, y: 336 });
  });

  it('窄视口中的高菜单无法翻转时限制在视口内', () => {
    expect(placeContextMenu(
      { x: 250, y: 500 },
      { width: 260, height: 700 },
      { width: 320, height: 740 },
    )).toEqual({ x: 52, y: 32 });
  });

  it('有足够空间时仍显示在右键位置下方', () => {
    expect(placeContextMenu(
      { x: 100, y: 100 },
      { width: 220, height: 300 },
      { width: 800, height: 600 },
    )).toEqual({ x: 104, y: 104 });
  });
});
