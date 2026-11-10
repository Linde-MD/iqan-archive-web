import { describe, expect, it } from 'vitest';
import { createProject } from '../src/domain/model';
import { gitGraphEdgePath, GIT_GRAPH, layoutGitGraph, recommendedParentNodes, type GitGraphEdge } from '../src/domain/git-graph';

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

  it('按显式分支顺序分配共享轨道与颜色，让优先分支的共享历史保持直线', () => {
    const graph = fixture();
    graph.branches[0]!.order = 1;
    graph.branches[1]!.order = 0;
    const layout = layoutGitGraph(graph, 'oldest');
    expect(layout.branchTracks.map(branch => branch.id)).toEqual(['feature', 'main']);
    expect(layout.rows.find(row => row.node.id === 'n2')?.laneIndex).toBe(0);
    expect(layout.rows.find(row => row.node.id === 'n4')?.laneIndex).toBe(0);
    expect(layout.edges.find(edge => edge.id === 'e1')).toMatchObject({
      color: '#d946ef', fromLane: 0, toLane: 0,
    });
    expect(layout.edges.find(edge => edge.id === 'e3')).toMatchObject({
      color: '#d946ef', fromLane: 0, toLane: 0,
    });
    expect(layout.edges.find(edge => edge.id === 'e2')).toMatchObject({
      color: '#2563eb', fromLane: 0, toLane: 1,
    });
  });

  it('分支标签长度不参与版本信息列宽度计算', () => {
    const graph = fixture();
    const initialWidth = layoutGitGraph(graph, 'oldest').width;
    graph.branches = graph.branches.map((branch, index) => ({
      ...branch,
      name: `${'长期分支名称'.repeat(12)}-${index}`,
    }));
    expect(layoutGitGraph(graph, 'oldest').width).toBe(initialWidth);
  });

  it('无重合历史的分支共用同一列节省画布宽度', () => {
    const graph = createProject('分支列复用', '1479');
    const projectId = graph.project.id;
    graph.nodes = ['V1', 'V2', 'V3', 'V4'].map(id => ({
      id, projectId, version: id, description: '', taskId: null, releasedAt: null,
    }));
    graph.edges = [
      { id: 'a', projectId, parentId: 'V1', childId: 'V2' },
      { id: 'b', projectId, parentId: 'V3', childId: 'V4' },
    ];
    graph.branches = [
      { id: 'branch-a', projectId, name: 'branch-a', description: '', color: '#16a34a', headId: 'V2', order: 0 },
      { id: 'branch-b', projectId, name: 'branch-b', description: '', color: '#dc2626', headId: 'V4', order: 1 },
    ];

    const layout = layoutGitGraph(graph, 'oldest');
    expect(layout.rows.find(row => row.node.id === 'V2')?.laneIndex).toBe(0);
    expect(layout.rows.find(row => row.node.id === 'V4')?.laneIndex).toBe(0);
    expect(layout.trackWidth).toBe(GIT_GRAPH.laneStart + 3 * GIT_GRAPH.laneGap + 14);
  });

  it('共享主干上不相交的独占分支段复用轨道列', () => {
    const graph = createProject('主干分支段复用', '1479');
    const projectId = graph.project.id;
    graph.nodes = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9'].map(id => ({
      id, projectId, version: id, description: '', taskId: null, releasedAt: null,
    }));
    graph.edges = [
      { id: 'a1', projectId, parentId: 'V1', childId: 'V2' },
      { id: 'a2', projectId, parentId: 'V2', childId: 'V3' },
      { id: 't1', projectId, parentId: 'V1', childId: 'V4' },
      { id: 't2', projectId, parentId: 'V4', childId: 'V5' },
      { id: 't3', projectId, parentId: 'V5', childId: 'V6' },
      { id: 'b1', projectId, parentId: 'V6', childId: 'V7' },
      { id: 'b2', projectId, parentId: 'V7', childId: 'V8' },
      { id: 'main-next', projectId, parentId: 'V6', childId: 'V9' },
    ];
    graph.branches = [
      { id: 'main', projectId, name: 'main', description: '', color: '#64748b', headId: 'V9', order: 0 },
      { id: 'branch-a', projectId, name: 'branch-a', description: '', color: '#2563eb', headId: 'V3', order: 1 },
      { id: 'branch-b', projectId, name: 'branch-b', description: '', color: '#16a34a', headId: 'V8', order: 2 },
    ];

    const layout = layoutGitGraph(graph, 'oldest');
    expect(layout.rows.find(row => row.node.id === 'V3')?.laneIndex)
      .toBe(layout.rows.find(row => row.node.id === 'V8')?.laneIndex);
    expect(layout.rows.find(row => row.node.id === 'V6')?.laneIndex)
      .not.toBe(layout.rows.find(row => row.node.id === 'V3')?.laneIndex);
  });

  it('从同一主干节点同时分叉的分支占用不同列', () => {
    const graph = createProject('共享主干分支复用', '1479');
    const projectId = graph.project.id;
    graph.nodes = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'].map(id => ({
      id, projectId, version: id, description: '', taskId: null, releasedAt: null,
    }));
    graph.edges = [
      { id: 'trunk', projectId, parentId: 'V1', childId: 'V2' },
      { id: 'blue-1', projectId, parentId: 'V2', childId: 'V3' },
      { id: 'blue-2', projectId, parentId: 'V3', childId: 'V4' },
      { id: 'purple-1', projectId, parentId: 'V2', childId: 'V5' },
      { id: 'purple-2', projectId, parentId: 'V5', childId: 'V6' },
    ];
    graph.branches = [
      { id: 'blue', projectId, name: 'blue', description: '', color: '#2563eb', headId: 'V4', order: 0 },
      { id: 'purple', projectId, name: 'purple', description: '', color: '#d946ef', headId: 'V6', order: 1 },
    ];

    const layout = layoutGitGraph(graph, 'oldest');
    expect(layout.rows.find(row => row.node.id === 'V2')?.laneIndex).toBe(0);
    expect(layout.rows.find(row => row.node.id === 'V4')?.laneIndex).toBe(layout.rows.find(row => row.node.id === 'V2')?.laneIndex);
    expect(layout.rows.find(row => row.node.id === 'V6')?.laneIndex).not.toBe(layout.rows.find(row => row.node.id === 'V2')?.laneIndex);
  });

  it('同一线性父子路径上的分支头仍显示在同一列', () => {
    const graph = createProject('线性分支头', '1479');
    const projectId = graph.project.id;
    graph.nodes = ['parent', 'child'].map(id => ({
      id, projectId, version: id, description: '', taskId: null, releasedAt: null,
    }));
    graph.edges = [{ id: 'edge', projectId, parentId: 'parent', childId: 'child' }];
    graph.branches = [
      { id: 'older', projectId, name: 'older', description: '', color: '#2563eb', headId: 'parent', order: 0 },
      { id: 'newer', projectId, name: 'newer', description: '', color: '#16a34a', headId: 'child', order: 1 },
    ];

    const layout = layoutGitGraph(graph, 'oldest');
    expect(layout.rows.find(row => row.node.id === 'parent')?.laneIndex)
      .toBe(layout.rows.find(row => row.node.id === 'child')?.laneIndex);
  });

  it('无 Branch 记录的独立树主干可复用不重叠的分支列', () => {
    const graph = createProject('无分支树列复用', '1479');
    const projectId = graph.project.id;
    graph.nodes = ['V1', 'V2', 'V3', 'V4'].map(id => ({
      id, projectId, version: id, description: '', taskId: null, releasedAt: null,
    }));
    graph.edges = [
      { id: 'main', projectId, parentId: 'V1', childId: 'V2' },
      { id: 'orphan-tree', projectId, parentId: 'V3', childId: 'V4' },
    ];
    graph.branches = [{ id: 'main', projectId, name: 'main', description: '', color: '#2563eb', headId: 'V2' }];

    const layout = layoutGitGraph(graph, 'oldest');
    expect(layout.rows.find(row => row.node.id === 'V2')?.laneIndex)
      .toBe(layout.rows.find(row => row.node.id === 'V4')?.laneIndex);
  });

  it('分支历史共享节点时不复用列', () => {
    const graph = createProject('共享历史不复用分支列', '1479');
    const projectId = graph.project.id;
    graph.nodes = ['V1', 'V2', 'V3', 'V4', 'V5'].map(id => ({
      id, projectId, version: id, description: '', taskId: null, releasedAt: null,
    }));
    graph.edges = [
      { id: 'trunk', projectId, parentId: 'V1', childId: 'V2' },
      { id: 'a', projectId, parentId: 'V2', childId: 'V3' },
      { id: 'b', projectId, parentId: 'V2', childId: 'V4' },
      { id: 'merge-a', projectId, parentId: 'V3', childId: 'V5' },
      { id: 'merge-b', projectId, parentId: 'V4', childId: 'V5' },
    ];
    graph.branches = [
      { id: 'main', projectId, name: 'main', description: '', color: '#64748b', headId: 'V5', order: 0 },
      { id: 'branch-a', projectId, name: 'branch-a', description: '', color: '#16a34a', headId: 'V3', order: 1 },
      { id: 'branch-b', projectId, name: 'branch-b', description: '', color: '#dc2626', headId: 'V4', order: 2 },
    ];

    const layout = layoutGitGraph(graph, 'oldest');
    expect(layout.rows.find(row => row.node.id === 'V3')?.laneIndex).not.toBe(layout.rows.find(row => row.node.id === 'V4')?.laneIndex);
  });

  it('不同分支头优先使用各自轨道，即使共同后代使其都属于优先分支历史', () => {
    const graph = createProject('头节点轨道', '1479');
    const projectId = graph.project.id;
    graph.nodes = ['parent', 'feature-a', 'feature-b', 'merge'].map(id => ({
      id, projectId, version: id, description: '', taskId: null, releasedAt: null,
    }));
    graph.edges = [
      { id: 'pa', projectId, parentId: 'parent', childId: 'feature-a' },
      { id: 'pb', projectId, parentId: 'parent', childId: 'feature-b' },
      { id: 'am', projectId, parentId: 'feature-a', childId: 'merge' },
      { id: 'bm', projectId, parentId: 'feature-b', childId: 'merge' },
    ];
    graph.branches = [
      { id: 'integration', projectId, name: 'integration', description: '', color: '#64748b', headId: 'merge', order: 0 },
      { id: 'feature-a', projectId, name: 'feature-a', description: '', color: '#16a34a', headId: 'feature-a', order: 1 },
      { id: 'feature-b', projectId, name: 'feature-b', description: '', color: '#dc2626', headId: 'feature-b', order: 2 },
    ];

    const layout = layoutGitGraph(graph, 'oldest');
    expect(layout.rows.find(row => row.node.id === 'feature-a')?.laneIndex).toBe(1);
    expect(layout.rows.find(row => row.node.id === 'feature-b')?.laneIndex).toBe(2);
  });

  it('同父节点的无分支归属子版本分叉到不同轨道，单链后续版本保持原轨道', () => {
    const graph = createProject('无分支分叉', '1479');
    const projectId = graph.project.id;
    graph.nodes = ['branch-head', 'child-a', 'child-b', 'child-a-next'].map(id => ({
      id, projectId, version: id, description: '', taskId: null, releasedAt: null,
    }));
    graph.edges = [
      { id: 'a', projectId, parentId: 'branch-head', childId: 'child-a' },
      { id: 'b', projectId, parentId: 'branch-head', childId: 'child-b' },
      { id: 'an', projectId, parentId: 'child-a', childId: 'child-a-next' },
    ];
    graph.branches = [{ id: 'main', projectId, name: 'main', description: '', color: '#2563eb', headId: 'branch-head' }];

    const layout = layoutGitGraph(graph, 'oldest');
    const childA = layout.rows.find(row => row.node.id === 'child-a')!;
    const childB = layout.rows.find(row => row.node.id === 'child-b')!;
    const childANext = layout.rows.find(row => row.node.id === 'child-a-next')!;
    expect(childA.laneIndex).not.toBe(childB.laneIndex);
    expect(childANext.laneIndex).toBe(childA.laneIndex);
  });

  it('即使只创建整合分支，实际树中的同父子路径仍分列', () => {
    const graph = createProject('实际树分叉', '1479');
    const projectId = graph.project.id;
    graph.nodes = ['parent', 'child-a', 'child-a-next', 'child-b', 'merge'].map(id => ({
      id, projectId, version: id, description: '', taskId: null, releasedAt: null,
    }));
    graph.edges = [
      { id: 'a', projectId, parentId: 'parent', childId: 'child-a' },
      { id: 'a-next', projectId, parentId: 'child-a', childId: 'child-a-next' },
      { id: 'b', projectId, parentId: 'parent', childId: 'child-b' },
      { id: 'merge-a', projectId, parentId: 'child-a-next', childId: 'merge' },
      { id: 'merge-b', projectId, parentId: 'child-b', childId: 'merge' },
    ];
    graph.branches = [{ id: 'integration', projectId, name: 'integration', description: '', color: '#64748b', headId: 'merge' }];

    const layout = layoutGitGraph(graph, 'oldest');
    const childA = layout.rows.find(row => row.node.id === 'child-a')!;
    const childANext = layout.rows.find(row => row.node.id === 'child-a-next')!;
    const childB = layout.rows.find(row => row.node.id === 'child-b')!;
    expect(childA.laneIndex).not.toBe(childB.laneIndex);
    expect(childANext.laneIndex).toBe(childA.laneIndex);
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
