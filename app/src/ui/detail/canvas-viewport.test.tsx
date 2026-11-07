import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { CanvasViewport } from './canvas-viewport';

afterEach(() => cleanup());

const MOCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50"/></svg>';

describe('CanvasViewport', () => {
  it('renders SVG, zoom controls, and default 100% zoom indicator', () => {
    render(<CanvasViewport svg={MOCK_SVG} label="Workflow diagram" />);
    expect(screen.getByRole('img', { name: 'Workflow diagram' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reset zoom to 100%/i }).textContent).toContain('100%');
  });

  it('zooms in when + is clicked and zooms out when - is clicked', () => {
    render(<CanvasViewport svg={MOCK_SVG} label="Workflow diagram" />);
    const zoomInBtn = screen.getByRole('button', { name: /zoom in/i });
    const zoomOutBtn = screen.getByRole('button', { name: /zoom out/i });

    fireEvent.click(zoomInBtn);
    expect(screen.getByRole('button', { name: /reset zoom to 100%/i }).textContent).toContain('125%');

    fireEvent.click(zoomOutBtn);
    expect(screen.getByRole('button', { name: /reset zoom to 100%/i }).textContent).toContain('100%');
  });

  it.each(['mouse', 'touch', 'pen'] as const)('pans with a %s pointer and stops after release', (pointerType) => {
    render(<CanvasViewport svg={MOCK_SVG} label="Workflow diagram" />);
    const stage = screen.getByRole('img', { name: 'Workflow diagram' });
    const target = stage.querySelector('[data-viewport-target="true"]') as HTMLDivElement;
    const setPointerCapture = vi.fn();
    Object.defineProperty(stage, 'setPointerCapture', { configurable: true, value: setPointerCapture });

    fireEvent.pointerDown(stage, {
      pointerId: 7,
      pointerType,
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 80,
    });
    expect(setPointerCapture).toHaveBeenCalledWith(7);

    // The stage captures the pointer so browsers keep targeting it beyond its bounds.
    fireEvent.pointerMove(stage, {
      pointerId: 7,
      pointerType,
      isPrimary: true,
      clientX: 135,
      clientY: 105,
    });
    expect(target.style.transform).toContain('translate(35px, 25px)');

    fireEvent.pointerUp(stage, { pointerId: 7, pointerType, isPrimary: true, button: 0 });
    expect(stage.className).not.toContain('cursor-grabbing');
    fireEvent.pointerMove(stage, {
      pointerId: 7,
      pointerType,
      isPrimary: true,
      clientX: 160,
      clientY: 130,
    });
    expect(target.style.transform).toContain('translate(35px, 25px)');
  });

  it('ends a cancelled drag and ignores other pointers and toolbar interactions', () => {
    render(<CanvasViewport svg={MOCK_SVG} label="Workflow diagram" />);
    const stage = screen.getByRole('img', { name: 'Workflow diagram' });
    const target = stage.querySelector('[data-viewport-target="true"]') as HTMLDivElement;
    const zoomIn = screen.getByRole('button', { name: /zoom in/i });
    Object.defineProperty(stage, 'setPointerCapture', { configurable: true, value: vi.fn() });

    fireEvent.pointerDown(stage, {
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 2,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(stage, {
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: 80,
      clientY: 60,
    });
    expect(target.style.transform).toContain('translate(0px, 0px)');

    fireEvent.pointerDown(zoomIn, {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(stage, {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 70,
      clientY: 40,
    });
    expect(target.style.transform).toContain('translate(0px, 0px)');
    fireEvent.click(zoomIn);
    expect(screen.getByRole('button', { name: /reset zoom to 100%/i }).textContent).toContain('125%');

    fireEvent.pointerDown(stage, {
      pointerId: 3,
      pointerType: 'pen',
      isPrimary: true,
      button: 0,
      clientX: 20,
      clientY: 25,
    });
    fireEvent.pointerMove(stage, {
      pointerId: 4,
      pointerType: 'touch',
      isPrimary: false,
      clientX: 60,
      clientY: 70,
    });
    fireEvent.pointerMove(stage, {
      pointerId: 3,
      pointerType: 'pen',
      isPrimary: true,
      clientX: 30,
      clientY: 40,
    });
    fireEvent.pointerCancel(stage, { pointerId: 3, pointerType: 'pen', isPrimary: true });
    expect(stage.className).not.toContain('cursor-grabbing');

    fireEvent.pointerMove(stage, {
      pointerId: 3,
      pointerType: 'pen',
      isPrimary: true,
      clientX: 70,
      clientY: 90,
    });
    expect(target.style.transform).toContain('translate(10px, 15px)');

    fireEvent.pointerDown(stage, {
      pointerId: 5,
      pointerType: 'pen',
      isPrimary: true,
      button: 0,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(stage, {
      pointerId: 5,
      pointerType: 'pen',
      isPrimary: true,
      clientX: 25,
      clientY: 30,
    });
    fireEvent.lostPointerCapture(stage, { pointerId: 5, pointerType: 'pen', isPrimary: true });
    expect(stage.className).not.toContain('cursor-grabbing');
    fireEvent.pointerMove(stage, {
      pointerId: 5,
      pointerType: 'pen',
      isPrimary: true,
      clientX: 50,
      clientY: 60,
    });
    expect(target.style.transform).toContain('translate(35px, 45px)');
  });

  it('sets touch behavior on the canvas stage for direct-manipulation panning', () => {
    render(<CanvasViewport svg={MOCK_SVG} label="Workflow diagram" />);
    expect(screen.getByRole('img', { name: 'Workflow diagram' }).style.touchAction).toBe('none');
  });

  describe('wheel zoom', () => {
    function fireWheel(init: WheelEventInit): boolean {
      const viewport = document.querySelector('[data-canvas-viewport]') as HTMLElement;
      const event = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true, ...init });
      fireEvent(viewport, event);
      return event.defaultPrevented;
    }

    it('leaves a plain wheel alone so the page still scrolls', () => {
      render(<CanvasViewport svg={MOCK_SVG} label="Workflow diagram" />);
      expect(fireWheel({})).toBe(false);
      expect(screen.getByRole('button', { name: /reset zoom to 100%/i }).textContent).toContain('100%');
    });

    it('cancels and zooms for Ctrl+wheel', () => {
      render(<CanvasViewport svg={MOCK_SVG} label="Workflow diagram" />);
      expect(fireWheel({ ctrlKey: true })).toBe(true);
      expect(screen.getByRole('button', { name: /reset zoom to 100%/i }).textContent).toContain('115%');
      expect(fireWheel({ ctrlKey: true, deltaY: 100 })).toBe(true);
      expect(screen.getByRole('button', { name: /reset zoom to 100%/i }).textContent).toContain('100%');
    });

    it('treats Meta+wheel like Ctrl+wheel, matching the advertised ⌘ shortcut', () => {
      render(<CanvasViewport svg={MOCK_SVG} label="Workflow diagram" />);
      expect(fireWheel({ metaKey: true })).toBe(true);
      expect(screen.getByRole('button', { name: /reset zoom to 100%/i }).textContent).toContain('115%');
    });

    it('zooms on an unmodified wheel inside the modal, where the dialog would otherwise scroll', () => {
      render(<CanvasViewport svg={MOCK_SVG} label="Workflow diagram" isModal />);
      expect(fireWheel({})).toBe(true);
      expect(screen.getByRole('button', { name: /reset zoom to 100%/i }).textContent).toContain('115%');
    });

    it('stops mutating zoom once the viewport unmounts', () => {
      const { unmount } = render(<CanvasViewport svg={MOCK_SVG} label="Workflow diagram" />);
      const element = document.querySelector('[data-canvas-viewport]') as HTMLElement;
      unmount();
      // The effect removed its listener, so a cancelable wheel is no longer cancelled.
      expect(element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))).toBe(true);
    });
  });

  it('fires onDownloadSvg and onPopout callbacks when respective buttons are clicked', () => {
    const handleDownload = vi.fn();
    const handlePopout = vi.fn();
    render(
      <CanvasViewport
        svg={MOCK_SVG}
        label="Workflow diagram"
        onDownloadSvg={handleDownload}
        onPopout={handlePopout}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /download vector svg/i }));
    expect(handleDownload).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /^expand diagram$/i }));
    expect(handlePopout).toHaveBeenCalledTimes(1);
  });
});
