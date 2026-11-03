import { describe, expect, it } from 'vitest';
import { createProject } from '../src/domain/model';
import { gitGraphEdgePath, layoutGitGraph, recommendedParentNodes, type GitGraphEdge } from '../src/domain/git-graph';

function fixture() {
  const graph = createProject('图测试', '1479');
  const projectId = graph.project.id;
  graph.nodes = ['V1.0-1', 'V1.0-2', 'V1.0-3', 'V1.0-4', 'V1.0-5'].map((version, index) => ({
    id: `n${index + 1}`, projectId, version, description: `说明 ${version}`, taskId: null, releasedAt: null,
  }));
  graph.edges = [
    { id: 'e1', projectId, parentId: 'n1', childId: 'n2' },
    { id: 'e2', projectId, parentId: 'n2', childId: 'n3' },
    { id: 'e3', projectId, parentId: 'n2', childId: 'n4' },
  ];
  graph.branches = [
    { id: 'main', projectId, name: 'main', description: '', color: '#2563eb', headId: 'n3' },
    { id: 'feature', projectId, name: 'feature', description: '', color: '#d946ef', headId: 'n4' },
  ];
  return graph;
}

describe('Git Graph 投影', () => {
  it.each([
    [0, 5, 0, 1, 'M 14 68 C 14 96, 40 96, 40 124 L 40 348'],
    [5, 0, 0, 1, 'M 14 348 C 14 320, 40 320, 40 292 L 40 68'],
    [0, 5, 1, 0, 'M 40 68 L 40 292 C 40 320, 14 320, 14 348'],
    [5, 0, 1, 0, 'M 40 348 L 40 124 C 40 96, 14 96, 14 68'],
    [0, 1, 0, 2, 'M 14 68 C 14 96, 66 96, 66 124 L 66 124'],
    [0, 5, 1, 1, 'M 40 68 L 40 348'],
  ])('连线在一行内换轨，其他部分竖直：%i→%i，轨道%i→%i', (fromRow, toRow, fromLane, toLane, expected) => {
    const edge: GitGraphEdge = {
      id: 'edge', projectId: 'project', parentId: 'parent', childId: 'child', color: '#2563eb',
      fromRow, toRow, fromLane, toLane,
    };
    expect(gitGraphEdgePath(edge)).toBe(expected);
  });

  it('按父边拓扑排列纵向历史，将无边版本放入独立轨道', () => {
    const graph = fixture();
    const layout = layoutGitGraph(graph, 'oldest');
    expect(layout.rows.map(row => row.node.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(layout.rows.find(row => row.node.id === 'n5')?.isolated).toBe(true);
    expect(layout.rows.find(row => row.node.id === 'n5')?.laneIndex)
      .toBeGreaterThan(layout.rows.find(row => row.node.id === 'n4')!.laneIndex);
    expect(layout.rows.find(row => row.node.id === 'n2')?.branchHeads).toEqual([]);
    expect(layout.rows.find(row => row.node.id === 'n3')?.branchHeads.map(branch => branch.name)).toEqual(['main']);
  });

  it('新到旧让子版本先显示，分支过滤保留对应祖先及游离版本', () => {
    const graph = fixture();
    const layout = layoutGitGraph(graph, 'newest', ['main']);
    expect(layout.rows.map(row => row.node.id)).toEqual(['n5', 'n3', 'n2', 'n1']);
    expect(layout.branchTracks.map(branch => branch.id)).toEqual(['main']);
    expect(layout.edges.map(edge => [edge.parentId, edge.childId])).toEqual([['n1', 'n2'], ['n2', 'n3']]);
  });

  it('多选显示祖先并集、共享祖先只出现一次，保留各分支轨道且不改数据', () => {
    const graph = fixture();
    const before = structuredClone(graph);
    const layout = layoutGitGraph(graph, 'oldest', ['main', 'feature']);
    expect(layout.rows.map(row => row.node.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(layout.branchTracks.map(branch => branch.id)).toEqual(['main', 'feature']);
    expect(layout.rows.find(row => row.node.id === 'n3')?.laneIndex).toBe(0);
    expect(layout.rows.find(row => row.node.id === 'n4')?.laneIndex).toBe(1);
    expect(graph).toEqual(before);
  });

  it('不选分支仅显示游离版本，重复或已删除分支不增加节点或轨道', () => {
    const graph = fixture();
    expect(layoutGitGraph(graph, 'oldest', []).rows.map(row => row.node.id)).toEqual(['n5']);
    const layout = layoutGitGraph(graph, 'oldest', ['feature', 'feature', 'deleted']);
    expect(layout.branchTracks.map(branch => branch.id)).toEqual(['feature']);
    expect(layout.rows.map(row => row.node.id)).toEqual(['n1', 'n2', 'n4', 'n5']);
  });

  it('父版本候选优先推荐相邻版本并排除自身和后代', () => {
    const graph = fixture();
    const candidates = recommendedParentNodes(graph, 'V1.0-3', 'n2');
    expect(candidates.map(node => node.id)).toEqual(['n5', 'n1']);
  });

  it.each(['oldest', 'newest'] as const)('隐藏游离版本重新压紧行序及边端点，不改变数据：%s', order => {
    const graph = fixture();
    const before = structuredClone(graph);
    const layout = layoutGitGraph(graph, order, null, true);
    expect(layout.rows).toHaveLength(4);
    expect(layout.rows.every(row => !row.isolated)).toBe(true);
    expect(layout.rows.map(row => row.rowIndex)).toEqual([0, 1, 2, 3]);
    for (const edge of layout.edges) {
      expect(layout.rows[edge.fromRow]?.node.id).toBe(edge.parentId);
      expect(layout.rows[edge.toRow]?.node.id).toBe(edge.childId);
    }
    expect(layoutGitGraph(graph, order, [], true).rows).toEqual([]);
    expect(layoutGitGraph(graph, order, ['feature'], true).rows.map(row => row.node.id).sort()).toEqual(['n1', 'n2', 'n4']);
    expect(layoutGitGraph(graph, order).rows).toHaveLength(5);
    expect(graph).toEqual(before);
  });
});
