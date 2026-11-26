// Before the first paint: which client the page runs in (desktop app, mobile app, browser), on which
// system, and whether frosted glass is enabled, as <html data-client data-os data-glass data-native-glass>,
// so native-feel and glass rules in globals.css apply without a flash.
export const PLATFORM_SCRIPT = `(function(){try{var d=document.documentElement,u=navigator.userAgent||"",w=window;
var c=w.mementoDesktop&&w.mementoDesktop.isDesktop?"desktop":(/MementoMobile/.test(u)||w.ReactNativeWebView)?"mobile":"web";
var o=/HarmonyOS|OpenHarmony/.test(u)?"harmony":/Android/.test(u)?"android":/iPhone|iPad|iPod/.test(u)||(/Macintosh/.test(u)&&navigator.maxTouchPoints>1)?"ios":/Mac OS X|Macintosh/.test(u)?"mac":/Windows/.test(u)?"windows":/CrOS/.test(u)?"chromeos":/Linux/.test(u)?"linux":"other";
var g="on";try{if(localStorage.getItem("dr_glass")==="off")g="off";}catch(e){}
d.setAttribute("data-client",c);d.setAttribute("data-os",o);d.setAttribute("data-glass",g);
d.setAttribute("data-native-glass",w.mementoDesktop&&w.mementoDesktop.nativeGlass?"1":"0");}catch(e){}})();`;
