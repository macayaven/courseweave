import {expect,it,vi} from 'vitest';
vi.hoisted(()=>{if(typeof globalThis.DragEvent==='undefined')Object.defineProperty(globalThis,'DragEvent',{value:class extends Event{}});});
import {Widget} from '@lumino/widgets';
import {RetainedSessionWidget} from '../src/retained-widget';
it('keeps the same attached iframe on close/reopen, and releases it only on true disposal',()=>{
 const widget=new RetainedSessionWidget();const iframe=document.createElement('iframe');widget.node.appendChild(iframe);Widget.attach(widget,document.body);
 const contentWindow=iframe.contentWindow;const dispose=vi.fn();widget.disposed.connect(dispose);
 widget.close();
 expect(widget.isDisposed).toBe(false);expect(widget.isHidden).toBe(true);expect(iframe.isConnected).toBe(true);expect(iframe.contentWindow).toBe(contentWindow);expect(dispose).not.toHaveBeenCalled();
 widget.show();expect(widget.isHidden).toBe(false);expect(iframe.contentWindow).toBe(contentWindow);
 widget.dispose();expect(dispose).toHaveBeenCalledOnce();expect(iframe.isConnected).toBe(false);
});
