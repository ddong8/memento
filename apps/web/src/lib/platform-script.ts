// Before the first paint: which client the page runs in (desktop app, mobile app, browser), on which
// system, and whether frosted glass is enabled, as <html data-client data-os data-glass data-native-glass>,
// so native-feel and glass rules in globals.css apply without a flash.
// Mobile app 1.0.156+ floats its tab bar over a full-bleed web view; the shell marks <html> with
// memento-native-shell / memento-glass-tabbar from a document-start script, but Android runs that script from
// onPageStarted, sometimes before <html> exists, so the classes never land and pages slide under the tab bar.
// Set them here too (from MementoMobile/<version> in the user agent), before React hydrates.
export const PLATFORM_SCRIPT = `(function(){try{var d=document.documentElement,u=navigator.userAgent||"",w=window;
var c=w.mementoDesktop&&w.mementoDesktop.isDesktop?"desktop":(/MementoMobile/.test(u)||w.ReactNativeWebView)?"mobile":"web";
var o=/HarmonyOS|OpenHarmony/.test(u)?"harmony":/Android/.test(u)?"android":/iPhone|iPad|iPod/.test(u)||(/Macintosh/.test(u)&&navigator.maxTouchPoints>1)?"ios":/Mac OS X|Macintosh/.test(u)?"mac":/Windows/.test(u)?"windows":/CrOS/.test(u)?"chromeos":/Linux/.test(u)?"linux":"other";
var g="on";try{if(localStorage.getItem("dr_glass")==="off")g="off";}catch(e){}
d.setAttribute("data-client",c);d.setAttribute("data-os",o);d.setAttribute("data-glass",g);
d.setAttribute("data-native-glass",w.mementoDesktop&&w.mementoDesktop.nativeGlass?"1":"0");
var m=/MementoMobile\\/(\\d+)\\.(\\d+)\\.(\\d+)/.exec(u);
if(m&&d.classList&&(+m[1]*1e6+ +m[2]*1e3+ +m[3])>=1000156)d.classList.add("memento-native-shell","memento-glass-tabbar");}catch(e){}})();`;
