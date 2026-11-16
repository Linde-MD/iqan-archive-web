import { describe, expect, it } from 'vitest';
import { taskDragScrollSpeed } from '../src/utils/task-drag-scroll';

describe('任务泳道拖拽边缘滚动', () => {
  it('中间不滚动，顶部向上、底部向下，越接近边缘越快且速度有上限', () => {
    expect(taskDragScrollSpeed(300, 100, 500)).toBe(0);
    expect(taskDragScrollSpeed(140, 100, 500)).toBeLessThan(0);
    expect(taskDragScrollSpeed(110, 100, 500)).toBeLessThan(taskDragScrollSpeed(140, 100, 500));
    expect(taskDragScrollSpeed(490, 100, 500)).toBeGreaterThan(taskDragScrollSpeed(460, 100, 500));
    expect(taskDragScrollSpeed(100, 100, 500)).toBe(-640);
    expect(taskDragScrollSpeed(550, 100, 500)).toBe(640);
  });

  it('很矮的列表保留中间停止区，不可见列表不滚动', () => {
    expect(taskDragScrollSpeed(115, 100, 130)).toBe(0);
    expect(taskDragScrollSpeed(101, 100, 130)).toBeLessThan(0);
    expect(taskDragScrollSpeed(129, 100, 130)).toBeGreaterThan(0);
    expect(taskDragScrollSpeed(100, 100, 100)).toBe(0);
    expect(taskDragScrollSpeed(100, 200, 100)).toBe(0);
  });
});
