// Before the first paint: which client the page runs in (desktop app, mobile app, browser) and on which
// system, as <html data-client data-os> (and data-window-material when the desktop window has a system material), so native-feel rules in globals.css apply to the apps only.
export const PLATFORM_SCRIPT = `(function(){try{var d=document.documentElement,u=navigator.userAgent||"",w=window;
var c=w.mementoDesktop&&w.mementoDesktop.isDesktop?"desktop":(/MementoMobile/.test(u)||w.ReactNativeWebView)?"mobile":"web";
var o=/HarmonyOS|OpenHarmony/.test(u)?"harmony":/Android/.test(u)?"android":/iPhone|iPad|iPod/.test(u)||(/Macintosh/.test(u)&&navigator.maxTouchPoints>1)?"ios":/Mac OS X|Macintosh/.test(u)?"mac":/Windows/.test(u)?"windows":/CrOS/.test(u)?"chromeos":/Linux/.test(u)?"linux":"other";
d.setAttribute("data-client",c);d.setAttribute("data-os",o);
var m=c==="desktop"&&w.mementoDesktop.windowMaterial;if(m)d.setAttribute("data-window-material",String(m));}catch(e){}})();`;
