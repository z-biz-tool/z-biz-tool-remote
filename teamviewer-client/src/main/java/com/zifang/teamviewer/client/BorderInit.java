package com.zifang.teamviewer.client;

import javax.swing.*;
import java.awt.*;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;

public class BorderInit extends JFrame {
    private static final long serialVersionUID = 1L;
    public JLabel jlbImg;
    private boolean flag;


    public boolean getFlag(){
        return this.flag;
    }
    public BorderInit()
    {

        this.flag=true;
        this.jlbImg = new JLabel();

        this.setTitle("远程监控IP:"+"127.0.0.1");
        this.setSize(1366, 768);
        this.setAlwaysOnTop(true);  //显示窗口始终在最前面
        this.add(jlbImg);
        this.setLocationRelativeTo(null);
        this.setExtendedState(Frame.MAXIMIZED_BOTH);
        this.setDefaultCloseOperation(DISPOSE_ON_CLOSE);
        this.setVisible(true);
        this.validate();

        //窗口关闭事件
        this.addWindowListener(new WindowAdapter() {
            public void windowClosing(WindowEvent e) {
                flag=false;
                BorderInit.this.dispose();
                System.out.println("窗体关闭");
                System.gc();
            }
        });
    }
}
