package com.zifang.teamviewer.client.netty.main;

import com.zifang.teamviewer.client.NettyClient;

import javax.swing.*;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.util.Random;

public class App extends JFrame implements ActionListener {
    private JSplitPane jSplitPane = new JSplitPane();
    private JPanel basicInfo = new JPanel();
    private JPanel controllerPanle = new JPanel();
    private NettyClient nettyClient = new NettyClient();
    private String userName;
    private String password;

    private JTextField controlId = new JTextField(10);
    private JButton controll = new JButton("点击");

    public App(){
        userName = "user"+ new Random().nextInt(50);
        password = "password" + new Random().nextInt(50);
        nettyClient.login(userName,password);
        this.build();
        this.setSize(500,500);
        this.setLocation(800,350);
        this.setVisible(true);
        this.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);

    }

    private void basicPanel(){

        basicInfo.add(new JLabel("用户姓名"));
        basicInfo.add(new JLabel(userName));
        basicInfo.add(new JLabel("用户密码"));
        basicInfo.add(new JLabel(password));
    }

    private void build() {
        basicPanel();
        controllerPanle();

        this.jSplitPane.setOrientation(JSplitPane.VERTICAL_SPLIT);
        this.jSplitPane.setDividerSize(5);//设置分割线的宽度
        this.jSplitPane.setTopComponent(basicInfo);
        this.jSplitPane.setBottomComponent(controllerPanle);

        this.add(jSplitPane);
    }

    private void controllerPanle() {
        controll.addActionListener(this);
        this.controllerPanle.add(new JLabel("请输入你要控制的controlId"));
        this.controllerPanle.add(controlId);
        this.controllerPanle.add(controll);
    }

    public static void main(String[] args) {
        new App();
    }

    @Override
    public void actionPerformed(ActionEvent e) {
        if(e.getSource() == controll){
            String controllerId = controlId.getText();
            nettyClient.control(controllerId);
            System.out.println(controllerId);
        }
    }
}
