import { describe, expect, it } from 'vitest';
import { createProject } from '../src/domain/model';
import { layoutGitGraph, recommendedParentNodes } from '../src/domain/git-graph';

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
    const layout = layoutGitGraph(graph, 'newest', 'main');
    expect(layout.rows.map(row => row.node.id)).toEqual(['n5', 'n3', 'n2', 'n1']);
    expect(layout.branchTracks.map(branch => branch.id)).toEqual(['main']);
    expect(layout.edges.map(edge => [edge.parentId, edge.childId])).toEqual([['n1', 'n2'], ['n2', 'n3']]);
  });

  it('父版本候选优先推荐相邻版本并排除自身和后代', () => {
    const graph = fixture();
    const candidates = recommendedParentNodes(graph, 'V1.0-3', 'n2');
    expect(candidates.map(node => node.id)).toEqual(['n5', 'n1']);
  });
});
