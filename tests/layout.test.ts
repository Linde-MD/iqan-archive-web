import { describe, expect, it } from 'vitest';
import { createProject } from '../src/domain/model';
import { layoutDag, LAYOUT } from '../src/domain/layout';

function graph(edges: [string, string][]) {
  const g = createProject('工程', '123');
  const p = g.project.id;
  const ids = [...new Set(edges.flat())];
  g.nodes = ids.map(id => ({ id, projectId: p, version: id, description: '', taskId: null, releasedAt: null }));
  g.edges = edges.map(([parentId, childId], index) => ({ id: `e${index}`, projectId: p, parentId: parentId!, childId: childId! }));
  return g;
}

describe('DAG 分层布局', () => {
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
