# TuneDeck 안드로이드 앱 — 전체 화면 WebView에 폰용 TuneDeck 화면(assets/index.html)을 띄움
#
# 같은 내용의 Java:
#   protected void onCreate(Bundle b) {
#     super.onCreate(b);
#     Window w = getWindow();
#     w.addFlags(FLAG_KEEP_SCREEN_ON);             // 앱을 보고 있는 동안 화면 꺼짐 방지
#     w.setStatusBarColor(0xFF120F14); w.setNavigationBarColor(0xFF120F14);
#     WebView web = new WebView(this); web.setBackgroundColor(0xFF120F14);
#     WebSettings s = web.getSettings();
#     s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
#     s.setMediaPlaybackRequiresUserGesture(false);
#     s.setUserAgentString(s.getUserAgentString().concat(" TuneDeckApp"));
#     setContentView(web);
#     String html = new Scanner(getAssets().open("index.html"), "UTF-8").useDelimiter("\\A").next();
#     // YouTube 플레이어가 정상 출처로 인식하도록 기준 주소를 https 로 지정
#     web.loadDataWithBaseURL("https://ghdwoals649-alt.github.io/tunedeck/", html, "text/html", "utf-8", null);
#   }

.class public Lcom/tunedeck/app/MainActivity;
.super Landroid/app/Activity;
.source "MainActivity.java"


.method public constructor <init>()V
    .registers 1

    invoke-direct {p0}, Landroid/app/Activity;-><init>()V

    return-void
.end method


.method protected onCreate(Landroid/os/Bundle;)V
    .registers 9

    invoke-super {p0, p1}, Landroid/app/Activity;->onCreate(Landroid/os/Bundle;)V

    # 창 설정: 화면 꺼짐 방지 + 상태바/내비게이션바 색
    invoke-virtual {p0}, Lcom/tunedeck/app/MainActivity;->getWindow()Landroid/view/Window;

    move-result-object v0

    const/16 v1, 0x80

    invoke-virtual {v0, v1}, Landroid/view/Window;->addFlags(I)V

    # 0xFF120F14
    const v1, -0xedf0ec

    invoke-virtual {v0, v1}, Landroid/view/Window;->setStatusBarColor(I)V

    invoke-virtual {v0, v1}, Landroid/view/Window;->setNavigationBarColor(I)V

    # WebView 만들기
    new-instance v0, Landroid/webkit/WebView;

    invoke-direct {v0, p0}, Landroid/webkit/WebView;-><init>(Landroid/content/Context;)V

    invoke-virtual {v0, v1}, Landroid/webkit/WebView;->setBackgroundColor(I)V

    invoke-virtual {v0}, Landroid/webkit/WebView;->getSettings()Landroid/webkit/WebSettings;

    move-result-object v2

    const/4 v3, 0x1

    invoke-virtual {v2, v3}, Landroid/webkit/WebSettings;->setJavaScriptEnabled(Z)V

    invoke-virtual {v2, v3}, Landroid/webkit/WebSettings;->setDomStorageEnabled(Z)V

    const/4 v3, 0x0

    invoke-virtual {v2, v3}, Landroid/webkit/WebSettings;->setMediaPlaybackRequiresUserGesture(Z)V

    invoke-virtual {v2}, Landroid/webkit/WebSettings;->getUserAgentString()Ljava/lang/String;

    move-result-object v3

    const-string v4, " TuneDeckApp"

    invoke-virtual {v3, v4}, Ljava/lang/String;->concat(Ljava/lang/String;)Ljava/lang/String;

    move-result-object v3

    invoke-virtual {v2, v3}, Landroid/webkit/WebSettings;->setUserAgentString(Ljava/lang/String;)V

    invoke-virtual {p0, v0}, Lcom/tunedeck/app/MainActivity;->setContentView(Landroid/view/View;)V

    # assets/index.html 읽기
    :try_start_0
    invoke-virtual {p0}, Lcom/tunedeck/app/MainActivity;->getAssets()Landroid/content/res/AssetManager;

    move-result-object v2

    const-string v3, "index.html"

    invoke-virtual {v2, v3}, Landroid/content/res/AssetManager;->open(Ljava/lang/String;)Ljava/io/InputStream;

    move-result-object v2

    new-instance v3, Ljava/util/Scanner;

    const-string v4, "UTF-8"

    invoke-direct {v3, v2, v4}, Ljava/util/Scanner;-><init>(Ljava/io/InputStream;Ljava/lang/String;)V

    const-string v4, "\\A"

    invoke-virtual {v3, v4}, Ljava/util/Scanner;->useDelimiter(Ljava/lang/String;)Ljava/util/Scanner;

    move-result-object v3

    invoke-virtual {v3}, Ljava/util/Scanner;->next()Ljava/lang/String;

    move-result-object v3
    :try_end_0
    .catch Ljava/lang/Exception; {:try_start_0 .. :try_end_0} :catch_0

    # web.loadDataWithBaseURL(base, html, "text/html", "utf-8", null) — 레지스터 v1..v6 연속 사용
    move-object v1, v0

    const-string v2, "https://ghdwoals649-alt.github.io/tunedeck/"

    const-string v4, "text/html"

    const-string v5, "utf-8"

    const/4 v6, 0x0

    invoke-virtual/range {v1 .. v6}, Landroid/webkit/WebView;->loadDataWithBaseURL(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V

    return-void

    :catch_0
    move-exception v2

    return-void
.end method
